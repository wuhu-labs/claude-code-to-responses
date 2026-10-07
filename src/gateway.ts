// Routes each Responses request to a lane: the live process when it sits at the previous response, otherwise a
// process rebuilt from the response store or from the client's history and the provider records it carries.
import type { FnTool, InItem, NormRequest, Part } from './api/request.ts'
import { ResponseState, SseSink } from './api/stream.ts'
import { Bridge } from './bridge.ts'
import {
  assistantEntries,
  assistantUuidFor,
  contextOf,
  hasToolResult,
  type LogContext,
  toolResultEntry,
  unknownToolEntry,
  userMessageEntry,
  userTextEntry,
} from './claude/entries.ts'
import { CLAUDE_CODE_VERSION, MCP_PREFIX, RESUME_LINE } from './claude/pins.ts'
import { claudeVersion, processIdentity } from './claude/process.ts'
import { type Config, ConfigError, paths } from './config.ts'
import { GatewayError, invalid, previousResponseNotFound, unsupported } from './errors.ts'
import { Active, type ChainSpec, type Head, Lane, MAX_RESULT_CHARS, outputChars } from './lane.ts'
import { type CallRef, decodeRecord, decodeThinking, digestItems, type ProviderRecord, RecordError, sha256, THINKING_PREFIX } from './records.ts'
import { ResponseStore } from './store.ts'

// deno-lint-ignore no-explicit-any
type Json = any

export interface GatewayEvent {
  at: number
  kind: string
  data: Json
}

/** What a request asks of Claude Code after the point the log is at. */
type Delivery =
  | { kind: 'turn'; parts: Part[] }
  | { kind: 'outputs'; outputs: Map<string, Part[]>; notices: string | null }

export class Gateway {
  readonly store: ResponseStore
  readonly bridge: Bridge
  readonly lanes = new Map<string, Lane>()
  readonly events: GatewayEvent[] = []
  private closed = false

  private constructor(readonly config: Config) {
    this.store = new ResponseStore(config.stateDir)
    this.bridge = new Bridge(config.bridgePort)
  }

  static async start(config: Config): Promise<Gateway> {
    const p = paths(config)
    const version = await claudeVersion(config.claudeBinary, {
      HOME: p.homeDir,
      CLAUDE_CONFIG_DIR: p.configDir,
      PATH: '/usr/bin:/bin',
      DISABLE_AUTOUPDATER: '1',
    })
    if (version !== CLAUDE_CODE_VERSION) {
      throw new Error(
        `Claude Code ${version} at ${config.claudeBinary} is not the measured version ${CLAUDE_CODE_VERSION}; run the probe against it before supporting it.`,
      )
    }
    await takeLock(config.stateDir)
    await sweepOrphans(p.runDir, config.claudeBinary, (kind, data) => console.error(`${kind} ${JSON.stringify(data)}`))
    return new Gateway(config)
  }

  note(kind: string, data: Json): void {
    this.events.push({ at: Date.now(), kind, data })
    if (this.events.length > 10000) this.events.splice(0, 1000)
  }

  /** Every lane whose process may still be running, live or dying. */
  private processes = new Set<Lane>()

  async close(): Promise<void> {
    this.closed = true
    await Promise.all([...this.processes].map((l) => l.kill('gateway_shutdown')))
    await this.bridge.close()
    releaseLock(this.config.stateDir)
  }

  private laneEvents = {
    note: (kind: string, data: Json) => this.note(kind, data),
    dead: (lane: Lane) => {
      if (this.lanes.get(lane.sessionId) === lane) this.lanes.delete(lane.sessionId)
      this.dying.set(lane.sessionId, lane.gone)
    },
    gone: (lane: Lane) => {
      this.processes.delete(lane)
    },
  }

  private addLane(lane: Lane): void {
    this.lanes.set(lane.sessionId, lane)
    this.processes.add(lane)
  }

  private workDir(sessionId: string): string {
    return `${this.config.workRoot}/${sessionId}`
  }

  /** Validates and starts a response; returns its event stream. Errors before streaming are thrown. */
  async create(req: NormRequest): Promise<ReadableStream<Uint8Array>> {
    if (this.closed) throw new GatewayError(503, 'server_error', 'shutting_down', 'The gateway is shutting down.')
    const chain: ChainSpec = {
      key: await sha256(JSON.stringify([req.model, req.effort, req.instructions, req.tools])),
      model: req.model,
      effort: req.effort,
      instructions: req.instructions,
      tools: req.tools,
    }
    const state = new ResponseState(req)
    // the chain is reserved from the moment its session is known until the response is attached to its lane,
    // so two requests can never both rebuild (or both continue) one chain
    const reservation: Reservation = { session: null }
    try {
      const plan = req.previousResponseId !== null
        ? await this.fromPrevious(req, chain, state, reservation)
        : await this.fromHistory(req, chain, state, reservation)
      return this.start(state, plan)
    } finally {
      if (reservation.session) this.reserved.delete(reservation.session)
    }
  }

  private start(state: ResponseState, plan: Plan): ReadableStream<Uint8Array> {
    const sink = new SseSink()
    const active = new Active(state, sink, plan.prevId, plan.covered)
    sink.send('response.created', { response: state.object() })
    sink.send('response.in_progress', { response: state.object() })
    const lane = plan.lane
    lane.attach(active)
    this.note('request', { session: lane.sessionId, response: state.id, path: state.gateway.path })
    if (plan.spawn) lane.spawn(plan.spawn)
    if (plan.delivery?.kind === 'turn') void lane.startTurn(plan.delivery.parts)
    else if (plan.delivery?.kind === 'outputs') lane.release(plan.delivery.outputs, plan.delivery.notices)
    return sink.stream
  }

  cancel(id: string): Json {
    for (const lane of this.lanes.values()) {
      if (lane.active?.state.id === id) {
        const state = lane.active.state
        lane.cancel(id, 'cancel_request')
        return state.object()
      }
    }
    if (this.store.has(id)) throw new GatewayError(409, 'conflict_error', 'response_not_in_progress', `Response '${id}' is not in progress.`, 'response_id')
    throw new GatewayError(404, 'not_found_error', 'not_found', `Response '${id}' not found.`, 'response_id')
  }

  private reserved = new Set<string>()
  /** Lanes being killed, by session: a rebuild waits for its predecessor's tail to be stored. */
  private dying = new Map<string, Promise<void>>()

  private async settled(session: string): Promise<void> {
    const d = this.dying.get(session)
    if (d) await d
  }

  /** Takes the chain for this request, synchronously: busy if a response is streaming or another request holds it. */
  private reserve(session: string, r: Reservation): void {
    if (this.reserved.has(session) || this.lanes.get(session)?.active) {
      throw new GatewayError(409, 'conflict_error', 'conversation_busy', 'Another response of this conversation is in progress.')
    }
    this.reserved.add(session)
    r.session = session
  }

  private async fromPrevious(req: NormRequest, chain: ChainSpec, state: ResponseState, reservation: Reservation): Promise<Plan> {
    const prev = req.previousResponseId!
    const rec = this.store.get(prev)
    if (!rec) throw previousResponseNotFound(prev, "it is not in this gateway's store")
    if (rec.chain !== chain.key) {
      throw previousResponseNotFound(prev, 'instructions, tools, model or reasoning effort changed, which starts a new Claude Code session')
    }
    const head: Head = { responseId: rec.id, end: rec.end, calls: rec.calls }
    const input = await this.withoutOwnReasoning(req.input, prev)
    const delivery = deliveryFor(head, input)
    this.reserve(rec.session, reservation)
    let lane = this.lanes.get(rec.session)
    if (lane && !lane.dead && lane.head?.responseId === prev) {
      state.gateway = { path: 'live', session: rec.session }
      return { lane, delivery, prevId: prev, covered: input, spawn: null }
    }
    if (lane) await lane.kill('superseded')
    await this.settled(rec.session)
    const records = this.store.chain(prev)
    if (!records) throw previousResponseNotFound(prev, 'its chain is incomplete in the store')
    lane = new Lane(rec.session, this.workDir(rec.session), chain, head, this.config, this.bridge, this.store, this.laneEvents)
    this.addLane(lane)
    const log = records.flatMap((r) => r.entries)
    lane.pending = this.store.tail(prev)
    const spawn = this.resumePlan(lane, log, head, delivery)
    state.gateway = { path: 'store', session: rec.session, records: records.length, resume: spawn.interruptedTurn ? 'interrupted_turn' : 'stdin' }
    return { lane, delivery: spawn.interruptedTurn ? null : delivery, prevId: prev, covered: input, spawn }
  }

  /**
   * Reasoning items sent back next to new input in previous_response_id mode are ignored: what they carry is already
   * the state `previous_response_id` names. Only the gateway's own may come back: a provider record of this chain, or
   * a thinking item in the gateway's encoding. Anything else is a 400, since it could only be meant as new input.
   */
  private async withoutOwnReasoning(input: InItem[], prev: string): Promise<InItem[]> {
    const chainIds = new Set((this.store.chain(prev) ?? []).map((r) => r.id))
    const out: InItem[] = []
    for (let i = 0; i < input.length; i++) {
      const it = input[i]
      if (it.kind !== 'reasoning') {
        out.push(it)
        continue
      }
      const enc = it.encrypted ?? ''
      if (enc.startsWith(THINKING_PREFIX) && decodeThinking(enc)) continue
      const r = await clientRecord(enc, i)
      if (r && chainIds.has(r.id)) continue
      throw invalid(
        `input[${i}]`,
        'Only reasoning items this gateway issued in this conversation can be sent back with previous_response_id.',
        'unexpected_reasoning_item',
      )
    }
    return out
  }

  /** The resume launch, with the interrupted-turn entries appended when the log stops at held calls. */
  private resumePlan(lane: Lane, log: string[], head: Head, delivery: Delivery) {
    if (delivery.kind === 'turn') return { resume: true, interruptedTurn: false, log, attempt: [] }
    const before = [...log, ...lane.pending]
    const attempt = this.interruptedEntries(contextOf(before, lane.sessionId, lane.workDir), before, head, delivery, lane.chain.tools)
    return { resume: true, interruptedTurn: true, log, attempt }
  }

  /** The tool results plus one user text: the notices that came with the outputs, else a fixed line. */
  private interruptedEntries(ctx: LogContext, log: string[], head: Head, d: Extract<Delivery, { kind: 'outputs' }>, tools: FnTool[] | null): string[] {
    const out = resultEntries(ctx, log, head.calls, d.outputs, tools)
    out.push(JSON.stringify(userTextEntry(ctx, d.notices ?? RESUME_LINE)))
    return out
  }

  private async fromHistory(req: NormRequest, chain: ChainSpec, state: ResponseState, reservation: Reservation): Promise<Plan> {
    const { groups, tail } = segment(req.input)
    if (tail.length === 0) throw invalid('input', 'The input ends with model output: there is nothing new to respond to.')
    if (groups.length === 0) {
      // a new conversation
      const sessionId = crypto.randomUUID()
      const delivery = deliveryFor(null, tail)
      this.reserve(sessionId, reservation)
      const lane = new Lane(sessionId, this.workDir(sessionId), chain, null, this.config, this.bridge, this.store, this.laneEvents)
      this.addLane(lane)
      state.gateway = { path: 'new', session: sessionId }
      return { lane, delivery, prevId: null, covered: tail, spawn: { resume: false, interruptedTurn: false } }
    }
    // the longest run of groups whose records chain onto each other and match the items
    const used: ProviderRecord[] = []
    let pendingGroups: Group[] = []
    let synth: Group[] = []
    let headId: string | null = null
    let session: string | null = null
    for (let gi = 0; gi < groups.length; gi++) {
      const g = groups[gi]
      pendingGroups.push(g)
      // a client may repeat an item it already sent; one record counted twice is still one record
      const encrypted = [...new Set(g.outputs.filter((i) => i.kind === 'reasoning' && i.encrypted).map((i) => (i as { encrypted: string }).encrypted))]
      const recs = (await Promise.all(encrypted.map((e) => clientRecord(e, gi)))).filter((r) => r !== null)
      if (recs.length === 0) continue
      const r = recs[recs.length - 1]!
      const fits = recs.length === 1 && r.chain === chain.key && r.prev === headId && (session === null || r.session === session) &&
        r.digest === await digestItems(pendingGroups.flatMap((x) => [...x.inputs, ...x.outputs]))
      // a record that does not continue the log (another chain, an edited history) is ignored: its group is synthesized,
      // unless a later record covers it
      if (!fits) continue
      used.push(r)
      headId = r.id
      session = r.session
      pendingGroups = []
    }
    if (pendingGroups.length) synth = pendingGroups
    const sessionId = session ?? crypto.randomUUID()
    this.reserve(sessionId, reservation)
    const existing = this.lanes.get(sessionId)
    if (existing) await existing.kill('superseded')
    await this.settled(sessionId)
    for (const r of used) if (!this.store.has(r.id)) this.store.put(r)

    // the records, then what Claude Code wrote after the last of them (if this gateway kept it)
    const log = used.flatMap((r) => r.entries)
    const tailLines = headId ? this.store.tail(headId) : []
    const workDir = this.workDir(sessionId)
    const ctx = contextOf([...log, ...tailLines], sessionId, workDir)
    const extra: string[] = []
    let head: Head
    if (synth.length) {
      const lastUsed = used[used.length - 1]
      let calls: { id: string; name: string }[] = lastUsed?.end === 'calls' ? lastUsed.calls : []
      for (let i = 0; i < synth.length; i++) {
        const g = synth[i]
        const d = i === 0 && used.length === 0
          ? deliveryFor(null, g.inputs, false)
          : deliveryFor({ responseId: '', end: calls.length ? 'calls' : 'turn', calls }, g.inputs, false)
        if (d.kind === 'turn') {
          extra.push(JSON.stringify(userMessageEntry(ctx, d.parts)))
          // a fresh session logs this latch after its first message; a resumed one missing it writes it outside the mirror
          if (i === 0 && used.length === 0) extra.push(JSON.stringify({ type: 'atis-latch', atis: '', sessionId }))
        } else {
          // completed calls: their outputs are history, whatever tools this request offers
          extra.push(...resultEntries(ctx, [...log, ...tailLines, ...extra], calls, d.outputs, null))
          if (d.notices !== null) extra.push(JSON.stringify(userTextEntry(ctx, d.notices)))
        }
        const a = assistantEntries(ctx, g.outputs, chain.model)
        for (const e of a.entries) extra.push(JSON.stringify(e))
        calls = a.calls
      }
      head = { responseId: '', end: calls.length ? 'calls' : 'turn', calls }
    } else {
      const last = used[used.length - 1]
      head = { responseId: last.id, end: last.end, calls: last.calls }
    }
    const delivery = deliveryFor(head, tail)
    const lane = new Lane(
      sessionId,
      workDir,
      chain,
      used.length ? { responseId: headId!, end: used[used.length - 1].end, calls: used[used.length - 1].calls } : null,
      this.config,
      this.bridge,
      this.store,
      this.laneEvents,
    )
    this.addLane(lane)
    const covered = [...synth.flatMap((g) => [...g.inputs, ...g.outputs]), ...tail]
    lane.pending = tailLines
    let spawn
    if (delivery.kind === 'turn') {
      spawn = { resume: true, interruptedTurn: false, log, attempt: extra }
    } else {
      const all = [...log, ...tailLines, ...extra]
      // calls Claude Code made (the head of the records) may be ones it answers itself; synthesized ones never are
      const r7 = this.interruptedEntries(contextOf(all, sessionId, workDir), all, head, delivery, synth.length ? null : chain.tools)
      spawn = { resume: true, interruptedTurn: true, log, attempt: [...extra, ...r7] }
    }
    state.gateway = {
      path: 'history',
      session: sessionId,
      records: used.length,
      synthesized_groups: synth.length,
      resume: spawn.interruptedTurn ? 'interrupted_turn' : 'stdin',
    }
    return { lane, delivery: spawn.interruptedTurn ? null : delivery, prevId: headId, covered, spawn }
  }
}

/**
 * Tool results for a log that stops at tool calls, in call order: the client's output for each; a call the log already
 * answers gets nothing more. `tools` is given only for outstanding calls Claude Code itself made in this chain: one of a
 * tool the chain doesn't define gets Claude Code's own error, as on the live path. Completed calls from a history
 * (`tools` null) always keep the client's outputs: a tool missing from this request changes nothing about them.
 */
function resultEntries(ctx: LogContext, log: string[], calls: CallRef[], outputs: Map<string, Part[]>, tools: FnTool[] | null): string[] {
  const names = tools ? new Set(tools.map((t) => t.name)) : null
  const out: string[] = []
  for (const c of calls) {
    const all = [...log, ...out]
    if (hasToolResult(all, c.id)) continue
    const entry = names === null || names.has(c.name)
      ? toolResultEntry(ctx, c.id, outputs.get(c.id)!, assistantUuidFor(all, c.id))
      : unknownToolEntry(ctx, c.id, MCP_PREFIX + c.name, assistantUuidFor(all, c.id))
    out.push(JSON.stringify(entry))
  }
  return out
}

/**
 * Kills the Claude Code processes a gateway that died without cleaning up left behind: every run folder still holding
 * a proc.json whose pid has the same start time and executable as recorded. A pid alone is never trusted.
 */
export async function sweepOrphans(runDir: string, binary: string, note: (kind: string, data: Json) => void): Promise<void> {
  for (const d of Deno.readDirSync(runDir)) {
    const dir = `${runDir}/${d.name}`
    try {
      const rec = JSON.parse(Deno.readTextFileSync(`${dir}/proc.json`))
      const now = await processIdentity(rec.pid)
      // the same executable, started within the window the gateway recorded around its spawn (ps reports whole seconds)
      const started = now ? Date.parse(now.started) : NaN
      const inWindow = started >= Math.floor(rec.spawnedFrom / 1000) * 1000 - 1000 && started <= rec.spawnedTo + 1000
      if (now && now.comm === binary && rec.binary === binary && inWindow) {
        try {
          Deno.kill(rec.pid, 'SIGKILL')
          note('orphan_killed', { pid: rec.pid, epoch: d.name })
        } catch { /* gone meanwhile */ }
      }
    } catch { /* no registry entry: nothing ran there */ }
    Deno.removeSync(dir, { recursive: true })
  }
}

/**
 * One gateway per state dir: a second one would sweep the first one's live processes. The lock file names the holder
 * by pid, start time and executable; a holder that is gone (or a reused pid) does not count.
 */
async function takeLock(stateDir: string): Promise<void> {
  const path = `${stateDir}/gateway.lock`
  try {
    const held = JSON.parse(Deno.readTextFileSync(path))
    const now = await processIdentity(held.pid)
    if (now && now.started === held.started && now.comm === held.comm) {
      throw new ConfigError(`another gateway (pid ${held.pid}) is using the state dir ${stateDir}; stop it first`)
    }
    Deno.removeSync(path) // a stale lock: its holder is gone
  } catch (e) {
    if (e instanceof ConfigError) throw e
    if (!(e instanceof Deno.errors.NotFound) && !(e instanceof SyntaxError)) throw e
  }
  const me = await processIdentity(Deno.pid)
  if (!me) throw new ConfigError("cannot read this process's own start time to lock the state dir")
  try {
    Deno.writeTextFileSync(path, JSON.stringify({ pid: Deno.pid, ...me }), { createNew: true, mode: 0o600 })
  } catch (e) {
    if (e instanceof Deno.errors.AlreadyExists) throw new ConfigError(`another gateway took the state dir ${stateDir} at the same moment`)
    throw e
  }
}

function releaseLock(stateDir: string): void {
  try {
    const held = JSON.parse(Deno.readTextFileSync(`${stateDir}/gateway.lock`))
    if (held.pid === Deno.pid) Deno.removeSync(`${stateDir}/gateway.lock`)
  } catch { /* none */ }
}

interface Reservation {
  session: string | null
}

interface Plan {
  lane: Lane
  delivery: Delivery | null
  prevId: string | null
  covered: InItem[]
  spawn: { resume: boolean; interruptedTurn: boolean; log?: string[]; attempt?: string[] } | null
}

interface Group {
  inputs: InItem[]
  outputs: InItem[]
}

/** A provider record from the client's history; a malformed one is the client's error, never silently skipped. */
async function clientRecord(s: string, group: number): Promise<ProviderRecord | null> {
  try {
    return await decodeRecord(s)
  } catch (e) {
    if (e instanceof RecordError) {
      throw invalid('input', `The provider record of response ${group + 1} in the history is malformed: ${e.message}.`, 'invalid_provider_record')
    }
    throw e
  }
}

function isOutput(i: InItem): boolean {
  return i.kind === 'reasoning' || i.kind === 'function_call' || (i.kind === 'message' && i.role === 'assistant')
}

/** Splits a history into response groups (the inputs since the previous response, then its outputs) and the new tail. */
export function segment(items: InItem[]): { groups: Group[]; tail: InItem[] } {
  const groups: Group[] = []
  let cur: Group = { inputs: [], outputs: [] }
  for (const it of items) {
    if (isOutput(it)) cur.outputs.push(it)
    else {
      if (cur.outputs.length) {
        groups.push(cur)
        cur = { inputs: [], outputs: [] }
      }
      cur.inputs.push(it)
    }
  }
  if (cur.outputs.length) {
    groups.push(cur)
    return { groups, tail: [] }
  }
  return { groups, tail: cur.inputs }
}

/**
 * What the new input asks of Claude Code given where its log stops. A new turn must carry something (`isNew`; a
 * history being rebuilt is taken as it is): an empty one would be a billed turn that answers nothing.
 */
function deliveryFor(head: Head | null, input: InItem[], isNew = true): Delivery {
  if (head === null || head.end === 'turn') {
    const parts: Part[] = []
    input.forEach((it, i) => {
      if (it.kind === 'function_call_output') throw invalid(`input[${i}]`, `No tool call is waiting for output '${it.callId}'.`, 'unexpected_tool_output')
      if (it.kind !== 'message' || it.role !== 'user') throw invalid(`input[${i}]`, 'New input must be user messages here.')
      parts.push(...it.parts)
    })
    if (isNew && !parts.some((p) => p.type === 'image' || p.text.trim() !== '')) {
      throw invalid('input', 'There is nothing new to respond to: the new input carries no content.')
    }
    return { kind: 'turn', parts }
  }
  const outputs = new Map<string, Part[]>()
  const notices: string[] = []
  const want = new Set(head.calls.map((c) => c.id))
  input.forEach((it, i) => {
    if (it.kind === 'function_call_output') {
      if (!want.has(it.callId)) throw invalid(`input[${i}].call_id`, `No tool call '${it.callId}' is waiting for output.`, 'unexpected_tool_output')
      if (outputs.has(it.callId)) throw invalid(`input[${i}].call_id`, `Duplicate output for '${it.callId}'.`)
      if (outputChars(it.parts) > MAX_RESULT_CHARS) {
        throw invalid(
          `input[${i}].output`,
          `Tool output exceeds ${MAX_RESULT_CHARS} characters; Claude Code would move it out to a file.`,
          'tool_output_too_large',
        )
      }
      outputs.set(it.callId, it.parts)
    } else if (it.kind === 'message' && it.role === 'user') {
      if (it.parts.some((p) => p.type !== 'text')) {
        throw unsupported(`input[${i}].content`, 'Notices sent with tool outputs carry text only (they go in through a hook).')
      }
      // a blank notice (empty content, or only whitespace) carries nothing: it is treated as absent
      const text = it.parts.map((p) => (p as { text: string }).text).join('\n')
      if (text.trim() !== '') notices.push(text)
    } else {
      throw invalid(`input[${i}]`, 'New input must be tool outputs and user messages here.')
    }
  })
  const missing = head.calls.filter((c) => !outputs.has(c.id)).map((c) => c.id)
  if (missing.length) throw invalid('input', `Missing outputs for tool calls: ${missing.join(', ')}.`, 'missing_tool_output')
  return { kind: 'outputs', outputs, notices: notices.length ? notices.join('\n\n') : null }
}

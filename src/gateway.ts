// Routes each Responses request to a lane: the live process when it sits at the previous response, otherwise a
// process rebuilt from the response store or from the client's history and the provider records it carries.
import type { InItem, NormRequest, Part } from './api/request.ts'
import { ResponseState, SseSink } from './api/stream.ts'
import { Bridge } from './bridge.ts'
import { assistantEntries, assistantUuidFor, contextOf, type LogContext, toolResultEntry, userMessageEntry, userTextEntry } from './claude/entries.ts'
import { CLAUDE_CODE_VERSION, RESUME_LINE } from './claude/pins.ts'
import { claudeVersion } from './claude/process.ts'
import { type Config, paths } from './config.ts'
import { GatewayError, invalid, previousResponseNotFound, unsupported } from './errors.ts'
import { Active, type ChainSpec, type Head, Lane, MAX_RESULT_CHARS, outputChars } from './lane.ts'
import { decodeRecord, digestItems, type ProviderRecord, sha256 } from './records.ts'
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
  }

  private laneEvents = {
    note: (kind: string, data: Json) => this.note(kind, data),
    dead: (lane: Lane) => {
      if (this.lanes.get(lane.sessionId) === lane) this.lanes.delete(lane.sessionId)
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
    const plan = req.previousResponseId !== null ? await this.fromPrevious(req, chain, state) : await this.fromHistory(req, chain, state)
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

  private busy(lane: Lane | undefined): void {
    if (lane?.active) throw new GatewayError(409, 'conflict_error', 'conversation_busy', 'Another response of this conversation is in progress.')
  }

  private async fromPrevious(req: NormRequest, chain: ChainSpec, state: ResponseState) {
    const prev = req.previousResponseId!
    const rec = this.store.get(prev)
    if (!rec) throw previousResponseNotFound(prev, "it is not in this gateway's store")
    if (rec.chain !== chain.key) {
      throw previousResponseNotFound(prev, 'instructions, tools, model or reasoning effort changed, which starts a new Claude Code session')
    }
    const head: Head = { responseId: rec.id, end: rec.end, calls: rec.calls }
    const delivery = deliveryFor(head, req.input)
    let lane = this.lanes.get(rec.session)
    this.busy(lane)
    if (lane && !lane.dead && lane.head?.responseId === prev) {
      state.gateway = { path: 'live', session: rec.session }
      return { lane, delivery, prevId: prev, covered: req.input, spawn: null }
    }
    if (lane) await lane.kill('superseded')
    const records = this.store.chain(prev)
    if (!records) throw previousResponseNotFound(prev, 'its chain is incomplete in the store')
    lane = new Lane(rec.session, this.workDir(rec.session), chain, head, this.config, this.bridge, this.store, this.laneEvents)
    this.addLane(lane)
    const log = records.flatMap((r) => r.entries)
    const spawn = this.resumePlan(lane, log, head, delivery)
    state.gateway = { path: 'store', session: rec.session, records: records.length, resume: spawn.interruptedTurn ? 'interrupted_turn' : 'stdin' }
    return { lane, delivery: spawn.interruptedTurn ? null : delivery, prevId: prev, covered: req.input, spawn }
  }

  /** The resume launch, with the interrupted-turn entries appended when the log stops at held calls. */
  private resumePlan(lane: Lane, log: string[], head: Head, delivery: Delivery) {
    if (delivery.kind === 'turn') return { resume: true, interruptedTurn: false, log }
    const ctx = contextOf(log, lane.sessionId, lane.workDir)
    const extra = this.interruptedEntries(ctx, log, head, delivery)
    lane.pending = extra
    return { resume: true, interruptedTurn: true, log: [...log, ...extra] }
  }

  /** The tool results plus one user text: the notices that came with the outputs, else a fixed line. */
  private interruptedEntries(ctx: LogContext, log: string[], head: Head, d: Extract<Delivery, { kind: 'outputs' }>): string[] {
    const out: string[] = []
    for (const c of head.calls) out.push(JSON.stringify(toolResultEntry(ctx, c.id, d.outputs.get(c.id)!, assistantUuidFor(log, c.id))))
    out.push(JSON.stringify(userTextEntry(ctx, d.notices ?? RESUME_LINE)))
    return out
  }

  private async fromHistory(req: NormRequest, chain: ChainSpec, state: ResponseState) {
    const { groups, tail } = segment(req.input)
    if (tail.length === 0) throw invalid('input', 'The input ends with model output: there is nothing new to respond to.')
    if (groups.length === 0) {
      // a new conversation
      const sessionId = crypto.randomUUID()
      const delivery = deliveryFor(null, tail)
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
      const recs = (await Promise.all(
        g.outputs.filter((i) => i.kind === 'reasoning' && i.encrypted).map((i) => decodeRecord((i as { encrypted: string }).encrypted)),
      )).filter((r) => r !== null)
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
    const existing = this.lanes.get(sessionId)
    this.busy(existing)
    if (existing) await existing.kill('superseded')
    for (const r of used) if (!this.store.has(r.id)) this.store.put(r)

    const log = used.flatMap((r) => r.entries)
    const workDir = this.workDir(sessionId)
    const ctx = contextOf(log, sessionId, workDir)
    const extra: string[] = []
    let head: Head
    if (synth.length) {
      const lastUsed = used[used.length - 1]
      let calls: { id: string; name: string }[] = lastUsed?.end === 'calls' ? lastUsed.calls : []
      for (let i = 0; i < synth.length; i++) {
        const g = synth[i]
        const d = i === 0 && used.length === 0
          ? deliveryFor(null, g.inputs)
          : deliveryFor({ responseId: '', end: calls.length ? 'calls' : 'turn', calls }, g.inputs)
        if (d.kind === 'turn') {
          extra.push(JSON.stringify(userMessageEntry(ctx, d.parts)))
          // a fresh session logs this latch after its first message; a resumed one missing it writes it outside the mirror
          if (i === 0 && used.length === 0) extra.push(JSON.stringify({ type: 'atis-latch', atis: '', sessionId }))
        } else {
          const all = [...log, ...extra]
          for (const c of calls) extra.push(JSON.stringify(toolResultEntry(ctx, c.id, d.outputs.get(c.id)!, assistantUuidFor(all, c.id))))
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
    let spawn
    if (delivery.kind === 'turn') {
      lane.pending = extra
      spawn = { resume: true, interruptedTurn: false, log: [...log, ...extra] }
    } else {
      const all = [...log, ...extra]
      const r7 = this.interruptedEntries(contextOf(all, sessionId, workDir), all, head, delivery)
      lane.pending = [...extra, ...r7]
      spawn = { resume: true, interruptedTurn: true, log: [...all, ...r7] }
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

interface Group {
  inputs: InItem[]
  outputs: InItem[]
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

/** What the new input asks of Claude Code given where its log stops. */
function deliveryFor(head: Head | null, input: InItem[]): Delivery {
  if (head === null || head.end === 'turn') {
    const parts: Part[] = []
    input.forEach((it, i) => {
      if (it.kind === 'function_call_output') throw invalid(`input[${i}]`, `No tool call is waiting for output '${it.callId}'.`, 'unexpected_tool_output')
      if (it.kind !== 'message' || it.role !== 'user') throw invalid(`input[${i}]`, 'New input must be user messages here.')
      parts.push(...it.parts)
    })
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
      notices.push(it.parts.map((p) => (p as { text: string }).text).join('\n'))
    } else {
      throw invalid(`input[${i}]`, 'New input must be tool outputs and user messages here.')
    }
  })
  const missing = head.calls.filter((c) => !outputs.has(c.id)).map((c) => c.id)
  if (missing.length) throw invalid('input', `Missing outputs for tool calls: ${missing.join(', ')}.`, 'missing_tool_output')
  return { kind: 'outputs', outputs, notices: notices.length ? notices.join('\n\n') : null }
}

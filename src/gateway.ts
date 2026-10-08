import { replayLog } from './replay.ts'
// Routes each Responses request to a lane: the live process when it sits at the previous response, otherwise a
// process rebuilt from the response store or from the client's history and the provider records it carries.
import type { InItem, NormRequest, Part } from './api/request.ts'
import { type EventSink, GatedSink, ResponseState, SseSink } from './api/stream.ts'
import { type CallAliases, matchRecordItems, remapItems } from './call_ids.ts'
import { Bridge } from './bridge.ts'
import {
  assistantEntries,
  assistantUuidFor,
  contextOf,
  hasToolResult,
  type LogContext,
  toolResultEntry,
  unknownToolEntry,
  userContentEntry,
  userMessageEntry,
} from './claude/entries.ts'
import { CLAUDE_CODE_VERSION, RESUME_LINE } from './claude/pins.ts'
import { claudeVersion, executableIdentity, processIdentity } from './claude/process.ts'
import { type Config, ConfigError, paths } from './config.ts'
import { asGatewayError, GatewayError, invalid, previousResponseNotFound } from './errors.ts'
import { Active, type ChainSpec, type Head, Lane, MAX_RESULT_CHARS, outputChars } from './lane.ts'
import { type CallRef, decodeRecord, decodeThinking, type ProviderRecord, RecordError, sha256, THINKING_PREFIX } from './records.ts'
import { ResponseStore } from './store.ts'
import { type FailureDiagnostic, FailureLog } from './failures.ts'

// deno-lint-ignore no-explicit-any
type Json = any

export interface GatewayEvent {
  at: number
  kind: string
  data: Json
}

/** Hook text is null only when the notice needs the image-capable interrupted-turn resume. */
interface Notice {
  parts: Part[]
  hookText: string | null
}

/** What a request asks of Claude Code after the point the log is at. */
type Delivery =
  | { kind: 'turn'; parts: Part[] }
  | { kind: 'outputs'; outputs: Map<string, Part[]>; notices: Notice | null }

export class Gateway {
  readonly store: ResponseStore
  readonly failures: FailureLog
  readonly bridge: Bridge
  readonly lanes = new Map<string, Lane>()
  readonly events: GatewayEvent[] = []
  private closed = false

  private constructor(readonly config: Config) {
    this.store = new ResponseStore(config.stateDir)
    this.failures = new FailureLog(config.stateDir)
    this.bridge = new Bridge(config.bridgePort)
  }

  static async start(config: Config): Promise<Gateway> {
    config = { ...config, claudeBinary: executableIdentity(config.claudeBinary) }
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

  private connections = new Set<() => void>()

  assertOpen(): void {
    if (this.closed) throw new GatewayError(503, 'server_error', 'shutting_down', 'The gateway is shutting down.')
  }

  /** Shutdown owns persistent transports too, including sockets sitting between turns. */
  trackConnection(close: () => void): () => void {
    this.assertOpen()
    this.connections.add(close)
    return () => this.connections.delete(close)
  }

  async close(): Promise<void> {
    this.closed = true
    for (const close of this.connections) close()
    this.connections.clear()
    await Promise.all([...this.processes].map((l) => l.kill('gateway_shutdown')))
    await this.bridge.close()
    releaseLock(this.config.stateDir)
  }

  private laneEvents = {
    failure: (record: FailureDiagnostic) => {
      // journald captures stderr in the service; never forward raw error messages or response output.
      try {
        this.failures.append(record)
      } catch (error) {
        console.error(`failure ${JSON.stringify({ ...record, diagnostic_error: 'failure_diagnostics_write_failed' })}`)
        throw error
      }
      console.error(`failure ${JSON.stringify(record)}`)
    },
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

  /** Every session runs in the one working folder: its environment block reads the same in every conversation. */
  private workDir(_sessionId: string): string {
    return this.config.workDir
  }

  /**
   * Validates and starts a response; returns its event stream once its first output event (or its end)
   * is coming. Errors before streaming are thrown, a backend 429 before any output among them (see GatedSink). A client
   * that leaves while the response is held is noticed when the stream reaches it: its cancel stops the lane then.
   * (The request's abort signal cannot say it sooner: Deno does not notice the disconnect after a body of a few KiB.)
   */
  async create(req: NormRequest): Promise<ReadableStream<Uint8Array>> {
    const sink = new SseSink()
    let decide!: (err: GatewayError | null) => void
    const decision = new Promise<GatewayError | null>((resolve) => decide = resolve)
    await this.createInto(req, new GatedSink(sink, { opened: () => decide(null), refused: (err) => decide(err) }))
    const err = await decision
    if (err) throw err
    return sink.stream
  }

  /** Both transports use the same validation, reservations, processes and durable response store. */
  async createInto(req: NormRequest, sink: EventSink): Promise<void> {
    this.assertOpen()
    if (req.instructions === null) {
      const prev = req.previousResponseId!
      const rec = this.store.get(prev)
      if (!rec) throw previousResponseNotFound(prev, "it is not in this gateway's store")
      const instructions = rec.instructions ?? this.lanes.get(rec.session)?.chain.instructions
      if (instructions === undefined) throw previousResponseNotFound(prev, 'this older record requires explicit instructions')
      req = { ...req, instructions }
    }
    // Preserve keys of pre-cap chains; an explicit cap is a process property, never an ignored request hint.
    const properties: unknown[] = [req.model, req.effort, req.instructions, req.tools]
    if (req.maxOutputTokens !== null) properties.push(req.maxOutputTokens)
    const chain: ChainSpec = {
      key: await sha256(JSON.stringify(properties)),
      model: req.model,
      effort: req.effort,
      instructions: req.instructions!,
      maxOutputTokens: req.maxOutputTokens,
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
      this.start(state, plan, sink)
    } finally {
      if (reservation.session) this.reserved.delete(reservation.session)
    }
  }

  private start(state: ResponseState, plan: Plan, sink: EventSink): void {
    const active = new Active(state, sink, plan.prevId, plan.covered, new Set(plan.spawn?.attempt ?? []))
    const lane = plan.lane
    try {
      lane.attach(active)
      // A socket may close while the asynchronous history/store plan is being built. Never launch or release
      // anything in that case; attach first so the same lane cancellation rolls back the attempt.
      if (sink.isClosed) {
        sink.onCancel?.()
        return
      }
      sink.send('response.created', { response: state.object() })
      sink.send('response.in_progress', { response: state.object() })
      // Initial event serialization can itself overflow the socket budget. Do not launch the model on a
      // request whose transport has already failed; later emission failures cancel at a microtask boundary.
      if (sink.isClosed) {
        sink.onCancel?.()
        return
      }
      this.note('request', { session: lane.sessionId, response: state.id, path: state.gateway.path })
      if (plan.spawn) lane.spawn(plan.spawn)
      if (plan.delivery?.kind === 'turn') void lane.startTurn(plan.delivery.parts)
      else if (plan.delivery?.kind === 'outputs') lane.release(plan.delivery.outputs, plan.delivery.notices?.hookText ?? null)
    } catch (error) {
      // Once attached, both transports own a streaming response. Never bubble an exception back to the
      // route's pre-stream error handler: fail/close that response and clear/kill its lane instead.
      lane.fail(asGatewayError(error))
    }
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
      throw previousResponseNotFound(prev, 'instructions, tools, model, reasoning effort or max_output_tokens changed, which starts a new Claude Code session')
    }
    const head: Head = { responseId: rec.id, end: rec.end, calls: rec.calls }
    const input = remapItems(await this.withoutOwnReasoning(req.input, prev), rec.callAliases ?? [])
    const delivery = deliveryFor(head, input)
    this.reserve(rec.session, reservation)
    let lane = this.lanes.get(rec.session)
    if (
      lane && !lane.dead && lane.head?.responseId === prev &&
      !(delivery.kind === 'outputs' && delivery.notices?.hookText === null)
    ) {
      state.gateway = { path: 'live', session: rec.session }
      return { lane, delivery, prevId: prev, covered: input, spawn: null }
    }
    if (lane) await lane.kill(delivery.kind === 'outputs' && delivery.notices?.hookText === null ? 'image_notice' : 'superseded')
    await this.settled(rec.session)
    const records = this.store.chain(prev)
    if (!records) throw previousResponseNotFound(prev, 'its chain is incomplete in the store')
    lane = new Lane(rec.session, this.workDir(rec.session), chain, head, this.config, this.bridge, this.store, this.laneEvents)
    lane.callAliases = rec.callAliases ?? []
    this.addLane(lane)
    const log = records.flatMap((r) => replayLog(r, this.store))
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
    const attempt = this.interruptedEntries(contextOf(before, lane.sessionId, lane.workDir), before, head, delivery)
    return { resume: true, interruptedTurn: true, log, attempt }
  }

  /** The tool results plus one user message: the notice text and images, else a fixed line. */
  private interruptedEntries(ctx: LogContext, log: string[], head: Head, d: Extract<Delivery, { kind: 'outputs' }>): string[] {
    const out = resultEntries(ctx, log, head.calls, d.outputs)
    out.push(JSON.stringify(userContentEntry(ctx, d.notices?.parts ?? [{ type: 'text', text: RESUME_LINE }])))
    return out
  }

  private async fromHistory(req: NormRequest, chain: ChainSpec, state: ResponseState, reservation: Reservation): Promise<Plan> {
    const { groups, tail: originalTail } = segment(req.input)
    let tail = originalTail
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
    const regenerated = new Map<string, string[]>()
    let pendingGroups: Group[] = []
    let synth: Group[] = []
    let headId: string | null = null
    let session: string | null = null
    let aliases: CallAliases = []
    for (let gi = 0; gi < groups.length; gi++) {
      const g = groups[gi]
      pendingGroups.push(g)
      // a client may repeat an item it already sent; one record counted twice is still one record
      const encrypted = [...new Set(g.outputs.filter((i) => i.kind === 'reasoning' && i.encrypted).map((i) => (i as { encrypted: string }).encrypted))]
      const recs = (await Promise.all(encrypted.map((e) => clientRecord(e, gi)))).filter((r) => r !== null)
      if (recs.length === 0) continue
      const r = recs[recs.length - 1]!
      const candidate = recs.length === 1 && r.chain === chain.key && (r.instructions === undefined || r.instructions === chain.instructions) &&
        r.prev === headId &&
        (session === null || r.session === session)
      const matched = candidate ? await matchRecordItems(pendingGroups.flatMap((x) => [...x.inputs, ...x.outputs]), r, aliases) : null
      if (candidate && matched === null) {
        used.length = 0
        aliases = []
        headId = null
        session = null
        pendingGroups = groups.slice(0, gi + 1)
      }
      const fits = matched !== null
      // a record that does not continue the log (another chain, an edited history) is ignored: its group is synthesized,
      // unless a later record covers it
      if (!fits) continue
      aliases = matched!
      regenerated.set(r.id, replayLog(r, this.store, remapItems(pendingGroups.flatMap((g) => [...g.inputs, ...g.outputs]), aliases)))
      used.push(r)
      headId = r.id
      session = r.session
      pendingGroups = []
    }
    const clientCalls = new Set(req.input.filter((it) => it.kind === 'function_call').map((it) => it.callId))
    if (tail.some((it) => it.kind === 'function_call_output' && !clientCalls.has(it.callId))) {
      used.length = 0
      aliases = []
      headId = null
      session = null
      pendingGroups = groups
    }
    // The provider log is never rewritten. Normalize the client-side delivery/digest instead.
    const remapGroup = (g: Group): Group => ({ inputs: remapItems(g.inputs, aliases), outputs: remapItems(g.outputs, aliases) })
    tail = remapItems(tail, aliases)
    pendingGroups = pendingGroups.map(remapGroup)
    if (pendingGroups.length) synth = pendingGroups
    // Validate every synthesized group and the new delivery before taking over a live lane or importing records.
    // Log synthesis stays after the old process settles: it must include any tail that eviction stores.
    const lastUsed = used[used.length - 1]
    let head: Head = { responseId: headId ?? '', end: lastUsed?.end ?? 'turn', calls: lastUsed?.calls ?? [] }
    const synthDeliveries: Delivery[] = []
    for (let i = 0; i < synth.length; i++) {
      const g = synth[i]
      synthDeliveries.push(deliveryFor(i === 0 && used.length === 0 ? null : head, g.inputs, false))
      const calls = g.outputs.flatMap((it) => it.kind === 'function_call' ? [{ id: it.callId, name: it.name }] : [])
      head = { responseId: '', end: calls.length ? 'calls' : 'turn', calls }
    }
    const delivery = deliveryFor(head, tail)
    const sessionId = session ?? crypto.randomUUID()
    this.reserve(sessionId, reservation)
    const existing = this.lanes.get(sessionId)
    if (existing) await existing.kill('superseded')
    await this.settled(sessionId)
    for (const r of used) if (!this.store.has(r.id)) this.store.put(r)
    // records made under another device id rebuild all the same (the model's bytes do not depend on it); only
    // metadata.user_id differs from before, which a backend cache keyed on it will notice. Diagnosis, never an error.
    const foreign = [...new Set(used.map((r) => r.device).filter((d) => d !== this.config.deviceId))]
    if (foreign.length) {
      this.note('device_mismatch', { session: sessionId, records: foreign, gateway: this.config.deviceId })
      console.error(`device_mismatch: session ${sessionId} was recorded under device ${foreign.join(', ')}; this gateway is ${this.config.deviceId}`)
    }

    // the records, then what Claude Code wrote after the last of them (if this gateway kept it)
    const log = used.flatMap((r) => regenerated.get(r.id)!)
    const tailLines = headId ? this.store.tail(headId) : []
    const workDir = this.workDir(sessionId)
    const ctx = contextOf([...log, ...tailLines], sessionId, workDir)
    const extra: string[] = []
    if (synth.length) {
      let calls: { id: string; name: string }[] = lastUsed?.end === 'calls' ? lastUsed.calls : []
      for (let i = 0; i < synth.length; i++) {
        const g = synth[i]
        const d = synthDeliveries[i]
        if (d.kind === 'turn') {
          extra.push(JSON.stringify(userMessageEntry(ctx, d.parts)))
          // a fresh session logs this latch after its first message; a resumed one missing it writes it outside the mirror
          if (i === 0 && used.length === 0) extra.push(JSON.stringify({ type: 'atis-latch', atis: '', sessionId }))
        } else {
          // completed calls: their outputs are history, whatever tools this request offers
          extra.push(...resultEntries(ctx, [...log, ...tailLines, ...extra], calls, d.outputs))
          if (d.notices !== null) extra.push(JSON.stringify(userContentEntry(ctx, d.notices.parts)))
        }
        const a = assistantEntries(ctx, g.outputs, chain.model)
        for (const e of a.entries) extra.push(JSON.stringify(e))
        calls = a.calls
      }
    }
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
    lane.callAliases = aliases
    lane.pending = tailLines
    let spawn
    if (delivery.kind === 'turn') {
      spawn = { resume: true, interruptedTurn: false, log, attempt: extra }
    } else {
      const all = [...log, ...tailLines, ...extra]
      // Answer client calls with their outputs and preserve unanswered native calls from any reused records.
      const r7 = this.interruptedEntries(contextOf(all, sessionId, workDir), all, head, delivery)
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
 * Tool results in model call order. `calls` names the client calls, whose outputs must be kept even in
 * synthesized history or with a changed tool set. Any other unanswered logged tool_use gets Code's native
 * error using its actual name; a result already in the log is never replaced or appended twice.
 */
function resultEntries(ctx: LogContext, log: string[], calls: CallRef[], outputs: Map<string, Part[]>): string[] {
  const out: string[] = []
  // A native error after a held MCP call may not have run yet when the process was evicted. Scan even when
  // rebuilding synthesized groups: the preceding reused record can still contain that unanswered call.
  const byId = new Map(calls.map((c) => [c.id, c]))
  const native = new Map<string, string>()
  const order: string[] = []
  for (const line of log) {
    const e = JSON.parse(line)
    if (e.type !== 'assistant' || !Array.isArray(e.message?.content)) continue
    for (const b of e.message.content) {
      if (b.type !== 'tool_use') continue
      order.push(b.id)
      if (!byId.has(b.id)) native.set(b.id, b.name)
    }
  }
  for (const id of [...new Set([...order, ...byId.keys()])]) {
    const all = [...log, ...out]
    if (hasToolResult(all, id)) continue
    const entry = byId.has(id)
      ? toolResultEntry(ctx, id, outputs.get(id)!, assistantUuidFor(all, id))
      : unknownToolEntry(ctx, id, native.get(id)!, assistantUuidFor(all, id))
    out.push(JSON.stringify(entry))
  }
  return out
}

/**
 * Kills the Claude Code processes a gateway that died without cleaning up left behind: every run folder still holding
 * a proc.json whose pid has the same start time and executable as recorded. A pid alone is never trusted.
 * An unmatched registry emits orphan_unmatched with a reason. Only potentially recoverable mismatches are retained.
 */
export async function sweepOrphans(runDir: string, binary: string, note: (kind: string, data: Json) => void): Promise<void> {
  binary = executableIdentity(binary)
  for (const d of Deno.readDirSync(runDir)) {
    const dir = `${runDir}/${d.name}`
    let rec: Json
    const unmatched = (reason: string) => {
      note('orphan_unmatched', { epoch: d.name, ...(Number.isInteger(rec?.pid) ? { pid: rec.pid } : {}), reason })
      if (!['executable_unavailable', 'executable_mismatch', 'kill_failed'].includes(reason)) Deno.removeSync(dir, { recursive: true })
    }
    try {
      rec = JSON.parse(Deno.readTextFileSync(`${dir}/proc.json`))
    } catch {
      unmatched('registry_unavailable')
      continue
    }
    if (!rec || typeof rec !== 'object' || !Number.isInteger(rec.pid) || rec.pid <= 0 || typeof rec.binary !== 'string') {
      unmatched('registry_invalid')
      continue
    }
    let now
    try {
      now = await processIdentity(rec.pid)
    } catch {
      unmatched('process_unavailable')
      continue
    }
    if (!now) {
      unmatched('process_unavailable')
      continue
    }
    let recordedBinary: string
    try {
      recordedBinary = executableIdentity(rec.binary)
    } catch {
      unmatched('executable_unavailable')
      continue
    }
    if (now.comm !== binary || recordedBinary !== binary) {
      unmatched('executable_mismatch')
      continue
    }
    // Same executable and start-time window: a reused pid alone is never trusted.
    const started = Date.parse(now.started)
    if (!(started >= Math.floor(rec.spawnedFrom / 1000) * 1000 - 1000 && started <= rec.spawnedTo + 1000)) {
      unmatched('start_time_mismatch')
      continue
    }
    try {
      Deno.kill(rec.pid, 'SIGKILL')
    } catch {
      unmatched('kill_failed')
      continue
    }
    note('orphan_killed', { pid: rec.pid, epoch: d.name })
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
  const notices: Part[][] = []
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
      // A blank text-only notice is absent; an image-only notice still carries content.
      if (it.parts.some((p) => p.type === 'image' || p.text.trim() !== '')) notices.push(it.parts)
    } else {
      throw invalid(`input[${i}]`, 'New input must be tool outputs and user messages here.')
    }
  })
  const missing = head.calls.filter((c) => !outputs.has(c.id)).map((c) => c.id)
  if (missing.length) throw invalid('input', `Missing outputs for tool calls: ${missing.join(', ')}.`, 'missing_tool_output')
  let notice: Notice | null = null
  if (notices.length) {
    const parts = notices.flat()
    if (parts.some((p) => p.type === 'image')) notice = { parts, hookText: null }
    else {
      // Preserve the existing text-only hook/resume bytes, including separators between messages.
      const text = notices.map((ps) => ps.map((p) => (p as { text: string }).text).join('\n')).join('\n\n')
      notice = { parts: [{ type: 'text', text }], hookText: text }
    }
  }
  return { kind: 'outputs', outputs, notices: notice }
}

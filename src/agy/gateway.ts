import { isDeepStrictEqual } from 'node:util'
import { dirname } from 'node:path'
import type { FnTool, InItem, NormRequest, Part } from '../api/request.ts'
import { type EventSink, GatedSink, newId, SseSink } from '../api/stream.ts'
import { Chains, type Reservation } from '../chains.ts'
import { asGatewayError, GatewayError, invalid, previousResponseNotFound, serverError, unsupported } from '../errors.ts'
import { type Group, matchHistory, segment } from '../history.ts'
import { bindCalls, type CallAliases, remapItems } from '../call_ids.ts'
import { ItemDigest, RECORD_PREFIX } from '../records.ts'
import { handler, type ResponsesEndpoint } from '../server.ts'
import { RecordStore } from '../store.ts'
import { agyEnvironment, reapOrphans } from './acp.ts'
import { type Exchange, injection, Lane, type Tier } from './lane.ts'
import { type Call, Output } from './output.ts'
import { AGY_RECORD_FAMILY, type AgyRecord, type CallRef, checkAgyRecord, encodeAgyRecord, readAgyRecord, RecordVerdict } from './record.ts'
import { stepsHash, stepsRowJson, stepsRowFromJson, type StepsRow, trajectoryFromJson, trajectoryJson } from './rows.ts'
import { AGY_VERSION } from './schema.ts'
import { callOf, completeStep, outputFileText, stepStart, type StepOutput } from './step.ts'
import { put, Store, StoreError } from './store.ts'
import type { Planner, Tokens } from './transcript.ts'
import { BRIDGE_PATH, MCP_NAME, object } from './wire.ts'

const checkedVersions = new Set([AGY_VERSION])
export type Config = {
  state: string
  agy: string
  port: number
  authToken?: string
  allowUncheckedVersion: boolean
  idleMs: number
  holdMs: number
  helper: string[]
}

/** What a request asks of agy given where its conversation stops. */
type Delivery =
  | { kind: 'turn'; text: string }
  /** Every output of the pending calls is in hand; `messages` are the client's, in order, whatever their role. */
  | { kind: 'outputs'; outputs: Map<string, string>; messages: Extract<InItem, { kind: 'message' }>[] }

/** The chain's fixed identity, from its head record. */
interface Identity {
  instructions: string
  model: string
  tools: FnTool[]
}

const shellWord = (text: string) => `'${text.replaceAll("'", `'"'"'`)}'`

export class AgyGateway implements ResponsesEndpoint {
  readonly inputMode = 'agy'
  /** One chain, one process: the live lanes, the busy rule and the wait for a dying predecessor. */
  readonly chains = new Chains<Lane>()
  private readonly records: RecordStore<AgyRecord>
  private readonly store: Store
  private readonly tokens = new Map<string, Lane>()
  private readonly active = new Map<string, () => unknown>()
  private readonly connections = new Set<() => void>()
  private usage: { plan_type: string | null; tier: Tier | null; tokens: Tokens | null } = { plan_type: null, tier: null, tokens: null }
  private closing: Promise<void> | undefined
  private origin = ''
  /** The agy version the running binary reported; records are stamped with it and validated against it. */
  private version = AGY_VERSION

  private constructor(readonly config: Config) {
    this.records = new RecordStore(config.state)
    this.store = new Store(config.state)
    try {
      const report = object(JSON.parse(Deno.readTextFileSync(`${config.state}/usage.json`)))
      if (report) this.usage = report as typeof this.usage
    } catch { /* no last usage report */ }
  }

  /** Every lane holding a process (tests evict through it, healthz counts it). */
  get lanes(): ReadonlyMap<string, Lane> {
    return this.chains.lanes
  }

  static async start(config: Config): Promise<AgyGateway> {
    Deno.mkdirSync(config.state, { recursive: true, mode: 0o700 })
    config = { ...config, state: Deno.realPathSync(config.state) }
    Deno.chmodSync(config.state, 0o700)
    const lock = Deno.openSync(`${config.state}/agy-gateway.lock`, { read: true, write: true, create: true, mode: 0o600 })
    try {
      if (!lock.tryLockSync(true)) throw new Error('another agy gateway owns this state directory')
      const gw = new AgyGateway(config)
      await reapOrphans(gw.store.gemini, gw.store.chains())
      const version = await new Deno.Command(config.agy, {
        args: ['--version'],
        env: agyEnvironment(),
        clearEnv: true,
        stdout: 'piped',
        stderr: 'null',
        signal: AbortSignal.timeout(5000),
      }).output()
      const reported = new TextDecoder().decode(version.stdout).trim()
      const semver = /(?:^|\s)v?(\d+\.\d+\.\d+(?:[-+][.\w-]+)?)(?=\s|$)/.exec(reported)?.[1]
      if (!version.success || !semver || (!checkedVersions.has(semver) && !config.allowUncheckedVersion)) {
        throw new Error(`agy version ${semver ?? '(unreadable)'} is not checked; use agy ${AGY_VERSION} or --allow-untested-agy.`)
      }
      gw.version = semver
      Deno.mkdirSync(`${gw.store.gemini}/config`, { recursive: true, mode: 0o700 })
      put(`${gw.store.gemini}/config/mcp_config.json`, {
        mcpServers: { [MCP_NAME]: { command: config.helper[0], args: [...config.helper.slice(1), '--mcp-shim'], timeoutSeconds: -1 } },
      })
      return gw
    } catch (e) {
      lock.close()
      throw e
    }
  }

  /** One loopback listener; only an unguessable, per-process token can address the private routes. */
  listen(onListen: (addr: Deno.NetAddr) => void) {
    const responses = handler(this)
    const server = Deno.serve({ hostname: '127.0.0.1', port: this.config.port, onListen }, (req) => {
      const path = new URL(req.url).pathname
      return path.startsWith(`${BRIDGE_PATH}/`) ? this.bridge(req, path.slice(BRIDGE_PATH.length + 1)) : responses(req)
    })
    this.origin = `http://127.0.0.1:${server.addr.port}`
    return server
  }

  private async bridge(req: Request, op: string): Promise<Response> {
    const token = req.headers.get('authorization')?.match(/^Bearer ([a-f0-9-]+)$/)?.[1]
    const lane = token ? this.tokens.get(token) : undefined
    if (!lane || lane.dead || req.method !== 'POST' || req.headers.get('content-type') !== 'application/json') {
      return new Response(null, { status: 404 })
    }
    try {
      const params = object(await req.json())
      if (!params || lane.dead) return new Response(null, { status: 400 })
      switch (op) {
        case 'list':
          return Response.json(lane.list())
        case 'hook':
          return Response.json(lane.hook(params))
        case 'call':
          return Response.json(await lane.tool(params))
        default:
          return new Response(null, { status: 404 })
      }
    } catch (e) {
      lane.fail(e)
      return new Response(null, { status: 502 })
    }
  }

  usageReport() {
    const { tokens } = this.usage
    return { ...this.usage, tokens: tokens ? { ...tokens, thought_tokens: tokens.thought_tokens ?? 0 } : null }
  }

  private report(tier: Tier | null, tokens: Tokens | null) {
    if (!tier && !tokens) return
    this.usage = { plan_type: tier?.id ?? this.usage.plan_type, tier: tier ?? this.usage.tier, tokens: tokens ?? this.usage.tokens }
    try {
      put(`${this.config.state}/usage.json`, this.usage)
    } catch {
      console.error('could not persist agy usage')
    }
  }

  assertOpen() {
    if (this.closing) throw new GatewayError(503, 'server_error', 'shutting_down', 'The agy gateway is stopping.')
  }

  trackConnection(close: () => void) {
    this.connections.add(close)
    return () => {
      this.connections.delete(close)
    }
  }

  close(): Promise<void> {
    return this.closing ??= Promise.resolve().then(async () => {
      for (const close of this.connections) close()
      try {
        await Promise.all([...this.chains.lanes.values()].map((lane) => lane.stop()))
      } finally {
        try {
          Deno.removeSync(`${this.config.state}/agy-gateway.lock`)
        } catch { /* gone */ }
      }
    })
  }

  cancel(id: string) {
    const live = this.active.get(id)
    if (live) return live()
    if (this.records.has(id)) throw new GatewayError(409, 'conflict_error', 'response_not_in_progress', 'The response is no longer in progress.')
    throw new GatewayError(404, 'not_found_error', 'not_found', 'No such response.')
  }

  async create(req: NormRequest): Promise<ReadableStream<Uint8Array>> {
    const sink = new SseSink()
    const decision = Promise.withResolvers<GatewayError | null>()
    await this.createInto(req, new GatedSink(sink, { opened: () => decision.resolve(null), refused: (err) => decision.resolve(err) }))
    const err = await decision.promise
    if (err) throw err
    return sink.stream
  }

  /**
   * The chain's identity comes from the request on a full create, or from the records on a continuation. The chain's
   * workspace, conversation and gemini dir are then fixed: every rebuild reproduces them, so the prompt agy sends
   * upstream — which names all three — is the same one.
   */
  async createInto(req: NormRequest, sink: EventSink): Promise<void> {
    this.assertOpen()
    const previous = req.previousResponseId
    const prev = previous === null ? null : this.byId(previous)
    if (previous !== null && !prev) throw previousResponseNotFound(previous, 'not in the agy response store')
    // The live process sitting exactly at the named parent is the state itself; its ancestors' records are the cache,
    // and a cache the gateway's store has lost is not a reason to refuse a request the process can serve.
    const laneAt = previous === null ? null : this.laneAt(previous)
    let chain = prev?.chain ?? ''
    let chainRecords: AgyRecord[] = []
    let head: AgyRecord | null = prev
    let input = req.input
    let cached = prev !== null
    let identity: Identity | null = null
    if (prev) {
      chainRecords = this.chainUpTo(prev)
      identity = this.identityOf(chainRecords, laneAt)
      if (identity && !continues(identity, req)) {
        throw previousResponseNotFound(prev.id, 'instructions, tools or the model changed, which starts a new agy chain; send a create without history')
      }
      input = remapItems(await this.withoutOwnReasoning(req.input, chainRecords), prev.callAliases ?? [])
      // cancellation while the echoed reasoning decodes: the request stops here, before it reserves or touches a lane
      if (sink.isClosed) return
    } else if (segment(req.input).groups.length === 0) {
      chain = newId('chain')
    } else {
      // a full create carrying history: only the records in it can rebuild the conversation
      const match = await this.matchRecords(req)
      if (match.head === null) {
        throw invalid('input', 'The history carries no usable agy provider record, so its conversation cannot be rebuilt; start a new conversation.', 'provider_record_missing')
      }
      if (match.synth.length) {
        throw invalid('input', 'The history carries responses this lane cannot place in one conversation; start a new conversation.', 'provider_record_missing')
      }
      // The history's records are the state and the rows a rebuild uses. The store is a cache: a copy it holds is
      // read (and validated) to decide whether this is a store-route hit, and a copy that fails is dropped so this
      // rebuild puts the transcript's own record back in its place — a corrupt cache never decides a request.
      let copies = 0
      for (const record of match.records) {
        const copy = this.records.get(record.id)
        if (!copy) continue
        try {
          this.stored(copy)
          copies++
        } catch {
          this.records.remove(copy.id)
        }
      }
      chainRecords = match.records
      cached = copies === chainRecords.length
      head = match.head
      chain = head.chain
      input = match.tail
      // a cancelled request must not touch the store: the client is gone and the chain's live process must survive
      if (sink.isClosed) return
      // a rebuild refills the store, so the next previous_response_id finds the whole chain
      for (const record of chainRecords) if (!this.records.has(record.id)) this.records.put(record)
    }
    identity ??= this.identityOf(chainRecords, laneAt)
    const instructions = identity?.instructions ?? req.instructions
    if (!instructions) throw invalid('instructions', 'Instructions are required.')
    const tools = identity?.tools ?? req.tools
    const model = identity?.model ?? req.model
    const delivery = deliveryFor(head, input)
    const reservation: Reservation = { chain: null }
    const output = new Output({ ...req, instructions, tools, model }, sink)
    let lane: Lane | undefined
    let settled = false
    // The reservation belongs to the request from here to its terminal commit (or its failure). While the request is
    // still planning, a cancellation marks it settled but must not hand the chain to another request that would touch
    // the same store; the release happens where the request stops touching it.
    let planning = true
    const detach = () => {
      settled = true
      sink.onCancel = null
      this.active.delete(output.id)
      if (!planning) this.chains.release(reservation)
    }
    const fail = (e: unknown, cancelled = false) => {
      if (settled) return output.object()
      detach()
      const err = asGatewayError(e)
      output.status = cancelled ? 'cancelled' : 'failed'
      output.error = err.toResponseError()
      if (lane) void lane.stop()
      const response = output.object()
      if (cancelled || !sink.refuse?.(err)) sink.send('response.failed', { response })
      sink.close()
      return response
    }
    const cancel = () => fail(new GatewayError(409, 'conflict_error', 'cancelled', 'The response was cancelled.'), true)
    sink.onCancel = cancel
    this.active.set(output.id, cancel)
    // A cancelled request does nothing further: no eviction, no store write, no launch, and no stopping of a process
    // it did not start. The chain's live process belongs to the client that is still there.
    const abandoned = () => settled || sink.isClosed
    this.assertOpen()
    try {
      this.chains.reserve(chain, reservation)
      if (abandoned()) return
      const live = this.chains.get(chain)
      const atHead = live !== undefined && !live.dead && !live.busy && live.head === (head?.id ?? null)
      let path: 'new' | 'live' | 'store' | 'history'
      let moved = false
      let patched = 0
      if (head === null) {
        lane = this.launch(chain, model, instructions, tools)
        await lane.start(null)
        path = 'new'
      } else if (atHead && (delivery.kind === 'turn' || live!.holding)) {
        lane = live!
        lane.detach()
        lane.head = head.id
        path = 'live'
      } else {
        if (abandoned()) return
        await this.chains.evict(chain, 'superseded')
        if (abandoned()) return
        moved = this.pathsMoved(chain, chainRecords)
        if (moved) console.error(`paths_moved: chain ${chain} was recorded under another state folder; its prompt differs (one cold cache miss)`)
        const rebuilt = this.laneFromRecords(chain, identity!, chainRecords, head, delivery)
        lane = rebuilt.lane
        patched = rebuilt.patched
        if (abandoned()) {
          await lane.stop()
          return
        }
        if (!(await lane.start(head.conversation))) {
          throw serverError('store_unreadable', `agy refused the conversation assembled from ${chainRecords.length} provider records.`)
        }
        path = cached ? 'store' : 'history'
      }
      if (abandoned()) {
        // only the process this request launched is stopped: a lane it merely sits at is the chain's
        if (path !== 'live') await lane.stop()
        return
      }
      this.assertOpen()
      this.report(lane.tier, null)
      output.gateway = {
        path,
        chain,
        conversation: lane.session,
        records: chainRecords.length,
        patched,
        ...(moved ? { paths: 'elsewhere' } : {}),
      }
      output.open()
      const attempt: Exchange = {
        output,
        fail,
        finish: async (calls, planner, tokens, incomplete) => {
          if (settled) return
          await this.commit({ output, sink, fail, lane: lane!, head, chainRecords, input, model, instructions, tools, calls, planner, tokens, incomplete, detach })
        },
      }
      if (path === 'live' && delivery.kind === 'outputs') {
        // only what is new since the matched parent steers the live process
        const notices = input.filter((it) => it.kind === 'message') as Extract<InItem, { kind: 'message' }>[]
        // The inputs are canonicalised to agy's call ids; the live process's calls are the client's.
        const results = new Map<string, string>()
        for (const [client, provider] of head?.callAliases ?? []) {
          const value = delivery.outputs.get(provider)
          if (value !== undefined) results.set(client, value)
        }
        for (const [id, value] of delivery.outputs) if (!results.has(id)) results.set(id, value)
        await lane.continue(attempt, results, injection(notices))
        return
      }
      const prompt = delivery.kind === 'turn' ? delivery.text : userPrompt(delivery.messages)
      const steps = delivery.kind === 'outputs' ? injection(delivery.messages.filter((m) => m.role !== 'user')) : []
      const running = lane
      void running.run(attempt, prompt, steps).catch((e) => {
        console.error('agy response failed', e)
        running.fail(e)
      })
    } catch (e) {
      fail(e)
    } finally {
      planning = false
      // a request that never attached to a lane holds the chain no longer; an attached one releases at its terminal
      // commit, so the chain stays busy through the record write even after the lane has no active exchange
      if (!lane) this.chains.release(reservation)
    }
  }

  /**
   * The stored chain ending at `prev`, as far back as the store still has it. A missing or unusable ancestor is a
   * cache miss: the parent record and the live process are the state a request at `prev` actually needs.
   */
  private chainUpTo(prev: AgyRecord): AgyRecord[] {
    const out: AgyRecord[] = [prev]
    const seen = new Set<string>([prev.id])
    let cur = prev
    while (cur.prev !== null) {
      if (seen.has(cur.prev)) break
      const stored = this.records.get(cur.prev)
      if (!stored) break
      let record: AgyRecord
      try {
        record = this.stored(stored)
      } catch {
        break
      }
      seen.add(record.id)
      out.push(record)
      cur = record
    }
    return out.reverse()
  }

  /** The live process sitting exactly at a response, if any: the only process a request at it can reuse. */
  private laneAt(id: string): Lane | null {
    for (const lane of this.chains.lanes.values()) if (!lane.dead && lane.head === id) return lane
    return null
  }

  /** A chain's identity: its first record, or the live process when the store has lost the chain's head record. */
  private identityOf(chainRecords: AgyRecord[], lane: Lane | null): Identity | null {
    const first = chainRecords[0]
    if (first && first.instructions !== undefined && first.model !== undefined && first.tools !== undefined) return chainIdentity(first)
    return lane ? { instructions: lane.instructions, model: lane.model, tools: lane.tools } : null
  }

  /** A stored response by id, validated; null when the store has none. */
  private byId(id: string): AgyRecord | null {
    const record = this.records.get(id)
    return record === null ? null : this.stored(record)
  }

  /** A record the gateway stored itself, re-validated: the store is a cache, never a bypass of the record rules. */
  private stored(record: AgyRecord): AgyRecord {
    try {
      return checkAgyRecord(record, this.version)
    } catch (e) {
      throw serverError('store_unreadable', `the gateway's store holds an unusable provider record: ${message(e)}`)
    }
  }

  /** The one reader of a record wherever it appears: history, or the gateway's store. */
  private async readRecord(content: string, param: string): Promise<AgyRecord | null> {
    try {
      return await readAgyRecord(content, this.version)
    } catch (e) {
      if (e instanceof RecordVerdict) {
        throw invalid(param, `${capitalize(e.message)}.`, e.kind === 'foreign' ? 'provider_record_foreign' : 'invalid_provider_record')
      }
      throw e
    }
  }

  /**
   * Whether a rebuild runs under the paths the chain was recorded at (both are in agy's prompt). Only the chain's
   * first record carries them: every later response inherits them, so the head is not the place to look.
   */
  private pathsMoved(chain: string, chainRecords: AgyRecord[]): boolean {
    const recorded = chainRecords.find((record) => record.gemini !== undefined && record.workspace !== undefined)
    if (!recorded) return false
    return recorded.workspace !== this.store.workspace(chain) || recorded.gemini !== this.store.gemini
  }

  /**
   * A continuation's reasoning items are the state `previous_response_id` already names: this lane's records are
   * dropped, and any other lane's or another agy version's record is refused. A corrupt one of ours is refused too.
   */
  private async withoutOwnReasoning(input: InItem[], chainRecords: AgyRecord[]): Promise<InItem[]> {
    const ids = new Set(chainRecords.map((record) => record.id))
    const out: InItem[] = []
    for (let i = 0; i < input.length; i++) {
      const item = input[i]
      if (item.kind !== 'reasoning') {
        out.push(item)
        continue
      }
      const content = item.encrypted ?? ''
      // a thinking item is ours too, but it carries no record: only an envelope is read (and judged) here
      if (!content.startsWith(RECORD_PREFIX) && !content.startsWith(AGY_RECORD_FAMILY)) continue
      const record = await this.readRecord(content, `input[${i}]`)
      if (record === null) continue
      if (ids.has(record.id)) continue
      throw invalid(`input[${i}]`, "This reasoning item is a provider record of another agy conversation; its state is not this chain's.", 'provider_record_foreign')
    }
    return out
  }

  /** The records of the request's history: the run of responses it continues. */
  private async matchRecords(req: NormRequest): Promise<{ records: AgyRecord[]; head: AgyRecord | null; tail: InItem[]; synth: Group[] }> {
    const { groups } = segment(req.input)
    const match = await matchHistory<AgyRecord, null>(groups, req.input, {
      decode: (content, group) => this.readRecord(content, `input[${group}]`) ,
      session: (record) => record.conversation,
      continues: (record) => record.instructions === undefined || continues({ instructions: record.instructions, model: record.model!, tools: record.tools! }, req),
      providerCalls: (record) => record.calls.map((call) => call.id),
      state: async () => null,
    })
    const records = match.used.map((used) => used.record)
    return { records, head: records[records.length - 1] ?? null, tail: match.tail, synth: match.synth }
  }

  /** A lane at a record's conversation: the store assembled from the chain's records, with pending calls completed. */
  private laneFromRecords(chain: string, identity: Identity, chainRecords: AgyRecord[], head: AgyRecord, delivery: Delivery): { lane: Lane; patched: number } {
    if (this.version !== AGY_VERSION) {
      throw serverError('store_unreadable', `agy ${this.version} is not the measured ${AGY_VERSION}: its store is never assembled or patched.`)
    }
    const conversation = head.conversation
    const rows = new Map<number, StepsRow>()
    for (const record of chainRecords) for (const row of record.steps) rows.set(row.idx, stepsRowFromJson(row))
    const recorded = chainRecords[0].trajectory
    if (!recorded) {
      throw invalid('input', 'The chain head record carries no trajectory metadata, so its store cannot be rebuilt.', 'provider_record_missing')
    }
    if (!recorded.blob) {
      throw invalid('input', 'The chain head record carries no trajectory blob, so its store cannot be rebuilt: the prompt would differ.', 'provider_record_missing')
    }
    const trajectory = trajectoryFromJson(recorded)
    const steps = [...rows.values()].sort((a, b) => a.idx - b.idx)
    const pending = steps.filter((row) => row.step_type === 132 && (row.status === 1 || row.status === 2))
    // Before any write: the store's pending calls are exactly the ones the record names, call id, name and
    // conversation included. A pending step the record does not name would be cancelled by agy's own resume.
    if (head.end === 'calls') {
      if (delivery.kind !== 'outputs') throw invalid('input', 'The response holds tool calls whose outputs are missing.', 'missing_tool_output')
      if (pending.length !== head.calls.length) {
        throw invalid('input', `The store holds ${pending.length} pending tool steps, but the response names ${head.calls.length} pending calls.`, 'store_mismatch')
      }
      for (let i = 0; i < head.calls.length; i++) {
        const row = pending[i]
        const call = head.calls[i]
        if (row.idx !== call.step) throw invalid('input', `The stored tail is not the pending calls this response names (call '${call.id}').`, 'store_mismatch')
        const own = callOf(row)
        if (!own || own.provider !== call.id || own.tool !== call.name || own.conversation !== conversation) {
          throw invalid('input', `The stored step ${row.idx} is not the pending call '${call.id}' in this conversation.`, 'store_mismatch')
        }
      }
      // The named calls are the tail of the store: a step after them means the record is not what the store ended on,
      // and agy's resume would open a conversation the response does not describe.
      const last = pending[pending.length - 1].idx
      const after = steps.find((row) => row.idx > last)
      if (after) {
        throw invalid('input', `The store holds a step ${after.idx} after the pending calls this response names.`, 'store_mismatch')
      }
    } else if (pending.length) {
      throw invalid('input', `The store holds ${pending.length} pending tool steps, but the response names no pending call.`, 'store_mismatch')
    }
    // The output files are written after the store is assembled: assembling replaces the conversation's brain folder,
    // and a step's `file://` result must survive.
    const files: { path: string; content: Uint8Array }[] = []
    if (head.end === 'calls' && delivery.kind === 'outputs') {
      for (let i = 0; i < head.calls.length; i++) {
        const call = head.calls[i]
        const row = rows.get(call.step)!
        const text = delivery.outputs.get(call.id)!
        const file = this.store.outputFile(conversation, row.idx)
        const output: StepOutput = { text, created: stepStart(row) ?? new Date(), completed: new Date(), outputUrl: file.url }
        let done: StepsRow
        try {
          done = completeStep(row, output)
        } catch (e) {
          throw invalid('input', `The stored step ${row.idx} is not agy's tool-call layout: ${message(e)}.`, 'step_layout_unknown')
        }
        rows.set(done.idx, done)
        files.push({ path: file.path, content: outputFileText(output) })
      }
    }
    this.store.assemble(conversation, { steps: [...rows.values()].sort((a, b) => a.idx - b.idx), trajectory })
    for (const file of files) {
      Deno.mkdirSync(dirname(file.path), { recursive: true, mode: 0o700 })
      Deno.writeFileSync(file.path, file.content, { mode: 0o600 })
    }
    return { lane: this.launch(chain, identity.model, identity.instructions, identity.tools), patched: files.length }
  }

  /**
   * Ends a response: the output items, its provider record cut from the store agy wrote, and the terminal batch —
   * written to disk before success is published, committed only when the transport accepted the whole batch.
   */
  private async commit(o: {
    output: Output
    sink: EventSink
    fail: (e: unknown) => unknown
    lane: Lane
    head: AgyRecord | null
    chainRecords: AgyRecord[]
    input: InItem[]
    model: string
    instructions: string
    tools: FnTool[]
    calls: Call[]
    planner: Planner | null
    tokens: Tokens | null
    incomplete: boolean
    detach: () => void
  }): Promise<void> {
    try {
      await this.finishRecord(o)
    } catch (e) {
      o.fail(e)
    }
  }

  private async finishRecord(o: {
    output: Output
    sink: EventSink
    fail: (e: unknown) => unknown
    lane: Lane
    head: AgyRecord | null
    chainRecords: AgyRecord[]
    input: InItem[]
    model: string
    instructions: string
    tools: FnTool[]
    calls: Call[]
    planner: Planner | null
    tokens: Tokens | null
    incomplete: boolean
    detach: () => void
  }): Promise<void> {
    const { output, sink, lane, head } = o
    const end = o.calls.length ? 'calls' : 'turn'
    const history = output.finalize(o.calls, o.planner ?? undefined)
    output.tokens = o.tokens
    const status = o.incomplete ? 'incomplete' : 'completed'
    const incomplete = o.incomplete ? { reason: 'max_output_tokens' } : null
    let record: AgyRecord
    let item: { type: string; id: string; summary: unknown[]; encrypted_content: string }
    try {
      const conversation = lane.session
      const recorded = new Map<number, string>()
      // Rows up to the highest index the records in hand cover were written before this response. agy's steps are
      // append-only, so an unrecorded row below that floor is an ancestor's unchanged row the store has lost, never
      // something this response wrote: it is neither re-recorded nor taken for one of this response's calls.
      let floor = -1
      for (const ancestor of o.chainRecords) {
        for (const row of ancestor.steps) {
          recorded.set(row.idx, stepsHash(row))
          floor = Math.max(floor, row.idx)
        }
      }
      // a response's own calls are the tool-call rows it changed and no ancestor record already names
      const named = new Set<number>()
      for (const ancestor of o.chainRecords) for (const call of ancestor.calls) named.add(call.step)
      const ownCalls = (steps: StepsRow[]) =>
        steps.filter((row) => row.step_type === 132 && !named.has(row.idx) && (recorded.has(row.idx) || row.idx > floor || row.status === 1))
          .sort((a, b) => a.idx - b.idx)
      const snapshot = await this.snapshotFor(conversation, ownCalls, o.calls.length)
      if (!snapshot) throw serverError('store_unreadable', `agy wrote no conversation store for ${conversation}.`)
      const fresh = snapshot.steps.filter((row) => row.idx > floor || (recorded.has(row.idx) && recorded.get(row.idx) !== stepsHash(stepsRowJson(row))))
      // the response's own calls: the tool-call rows no ancestor record names, in agy's order. One may be a queued
      // row that has not executed yet (the one-call fallback), so this reads the whole store, not only the changes.
      const callSteps = ownCalls(snapshot.steps)
      const refs: CallRef[] = o.calls.map((call, i) => {
        const row = callSteps[i]
        const own = row ? callOf(row) : null
        if (!row || !own || own.tool !== call.name) {
          throw serverError('store_mismatch', `agy's store does not hold a step for tool call '${call.name}'.`)
        }
        return { id: own.provider, name: call.name, step: row.idx }
      })
      const aliases = [...(head?.callAliases ?? [])]
      // The alias helper refuses a pair set that is not one-to-one both ways; a record it cannot express would not
      // replay its own response, so nothing is written at all.
      if (!bindCalls(aliases, refs.map((ref, i) => [o.calls[i].callId, ref.id] as [string, string]))) {
        throw serverError('store_mismatch', `agy's store bound this response's tool calls many-to-one, which cannot be replayed.`)
      }
      const digest = new ItemDigest(remapItems(o.input, aliases)).finish(remapItems(history, aliases))
      record = {
        v: 1,
        id: output.id,
        prev: head?.id ?? null,
        chain: lane.laneId,
        ...(head === null ? { instructions: o.instructions, model: o.model, tools: o.tools } : {}),
        conversation,
        ...(head === null ? { gemini: this.store.gemini, workspace: this.store.workspace(lane.laneId) } : {}),
        end,
        calls: refs,
        ...(aliases.length ? { callAliases: aliases } : {}),
        ...digest,
        agy: this.version,
        steps: fresh.map(stepsRowJson),
        ...(head === null && snapshot.trajectory ? { trajectory: trajectoryJson(snapshot.trajectory) } : {}),
      }
      item = { type: 'reasoning', id: newId('rs'), summary: [], encrypted_content: await encodeAgyRecord(record) }
    } catch (e) {
      o.fail(e instanceof StoreError ? serverError('store_unreadable', e.message) : e)
      return
    }
    const index = output.output.length
    const response = { ...output.object(), output: [...output.output, item], status, incomplete_details: incomplete }
    const send = sink.prepare([
      { type: 'response.output_item.added', data: { output_index: index, item } },
      { type: 'response.output_item.done', data: { output_index: index, item } },
      { type: `response.${status}`, data: { response } },
    ])
    if (!send) {
      sink.onCancel?.()
      return
    }
    try {
      this.records.put(record)
    } catch (e) {
      o.fail(e)
      return
    }
    if (!send()) {
      this.records.remove(record.id)
      sink.onCancel?.()
      return
    }
    output.output.push(item)
    output.status = status
    output.incomplete = incomplete
    lane.head = output.id
    this.report(lane.tier, o.tokens)
    lane.armEviction()
    o.detach()
    sink.close()
  }

  /** The store's rows once they hold every call's step; agy writes them just before it calls the tool. */
  private async snapshotFor(conversation: string, ownCalls: (steps: StepsRow[]) => StepsRow[], calls: number) {
    const deadline = performance.now() + 2000
    for (;;) {
      const snapshot = this.store.snapshot(conversation)
      if (!snapshot) return null
      if (!calls) return snapshot
      if (ownCalls(snapshot.steps).length >= calls) return snapshot
      if (performance.now() > deadline) return snapshot
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }

  private launch(chain: string, model: string, instructions: string, tools: FnTool[]): Lane {
    const lane = new Lane({
      chain,
      model,
      instructions,
      tools,
      origin: this.origin,
      workspace: this.store.workspace(chain),
      gemini: this.store.gemini,
      agy: this.config.agy,
      hook: [...this.config.helper, '--invocation-hook'].map(shellWord).join(' '),
      idleMs: this.config.idleMs,
      holdMs: this.config.holdMs,
    }, () => {
      // the process is gone: the lane stops serving and a rebuild may wait for it
      this.chains.dead(lane)
      this.tokens.delete(lane.token)
    })
    this.chains.add(lane)
    this.tokens.set(lane.token, lane)
    return lane
  }
}

/** The prompt a rebuilt conversation is reopened with: the client's user messages, or one space when it sent none. */
function userPrompt(messages: Extract<InItem, { kind: 'message' }>[]): string {
  const parts = messages.filter((m) => m.role === 'user').map((m) => text(m.parts)).filter((value) => value.trim() !== '')
  return parts.length ? parts.join('\n\n') : ' '
}

function capitalize(text: string): string {
  return text.length ? text[0].toUpperCase() + text.slice(1) : text
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function chainIdentity(head: AgyRecord): Identity {
  if (!head.instructions || !head.model || !head.tools) throw new Error(`chain head ${head.id} carries no instructions, model or tools`)
  return { instructions: head.instructions, model: head.model, tools: head.tools }
}

/** Whether the request asks for the same chain: same prompt, tools and model. */
function continues(identity: Identity, req: NormRequest): boolean {
  if (req.instructions !== null && req.instructions !== identity.instructions) return false
  if (req.model !== identity.model) return false
  return !req.toolsSpecified || isDeepStrictEqual(req.tools, identity.tools)
}

function text(parts: Part[]): string {
  return parts.map((p) => p.type === 'text' ? p.text : '').join('\n')
}

/** What the new input asks of agy given where its conversation stops. */
function deliveryFor(head: AgyRecord | null, input: InItem[]): Delivery {
  if (head === null || head.end === 'turn') {
    const texts: string[] = []
    input.forEach((it, i) => {
      if (it.kind === 'function_call_output') throw invalid(`input[${i}]`, `No tool call is waiting for output '${it.callId}'.`, 'unexpected_tool_output')
      if (it.kind !== 'message' || it.role !== 'user') throw invalid(`input[${i}]`, 'New input must be user messages here.')
      texts.push(text(it.parts))
    })
    const prompt = texts.join('\n\n')
    if (!prompt.trim()) throw invalid('input', 'There is nothing new to respond to: the new input carries no content.')
    return { kind: 'turn', text: prompt }
  }
  const outputs = new Map<string, string>()
  const messages: Extract<InItem, { kind: 'message' }>[] = []
  const want = new Set(head.calls.map((call) => call.id))
  input.forEach((it, i) => {
    if (it.kind === 'function_call_output') {
      if (!want.has(it.callId)) throw invalid(`input[${i}].call_id`, `No tool call '${it.callId}' is waiting for output.`, 'unexpected_tool_output')
      if (outputs.has(it.callId)) throw invalid(`input[${i}].call_id`, `Duplicate output for '${it.callId}'.`, 'unexpected_tool_output')
      outputs.set(it.callId, text(it.parts))
    } else if (it.kind === 'message' && (it.role === 'user' || it.role === 'developer' || it.role === 'system')) {
      if (it.parts.some((p) => p.type === 'text' && p.text.trim() !== '')) messages.push(it)
    } else {
      throw unsupported(`input[${i}]`, 'A delta accepts tool outputs and user, developer or system messages.')
    }
  })
  const missing = head.calls.filter((call) => !outputs.has(call.id)).map((call) => call.id)
  if (missing.length) throw invalid('input', `Missing outputs for tool calls: ${missing.join(', ')}.`, 'missing_tool_output')
  return { kind: 'outputs', outputs, messages }
}


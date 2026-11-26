import { isDeepStrictEqual } from 'node:util'
import { dirname } from 'node:path'
import type { FnTool, InItem, NormRequest, Part } from '../api/request.ts'
import { type EventSink, GatedSink, newId, SseSink } from '../api/stream.ts'
import { Chains, type Reservation } from '../chains.ts'
import { asGatewayError, GatewayError, invalid, previousResponseNotFound, serverError, unsupported } from '../errors.ts'
import { type Group, matchHistory, segment } from '../history.ts'
import { type CallAliases, remapItems } from '../call_ids.ts'
import { ItemDigest, RECORD_PREFIX, RecordError } from '../records.ts'
import { handler, type ResponsesEndpoint } from '../server.ts'
import { RecordStore } from '../store.ts'
import { agyEnvironment, reapOrphans } from './acp.ts'
import { type Exchange, injection, Lane, type Tier } from './lane.ts'
import { type Call, Output } from './output.ts'
import { AGY_RECORD_PREFIX, type AgyRecord, type CallRef, decodeAgyRecord, encodeAgyRecord, isForeignRecord } from './record.ts'
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
  /** Every output of the pending calls is in hand; `messages` is the client's steering text, if any. */
  | { kind: 'outputs'; outputs: Map<string, string>; messages: string | null }

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
    const prev = previous === null ? null : this.records.get(previous)
    if (previous !== null && !prev) throw previousResponseNotFound(previous, 'not in the agy response store')
    let chain = prev?.chain ?? ''
    let chainRecords: AgyRecord[] = []
    let head: AgyRecord | null = prev
    let input = req.input
    if (prev) {
      chainRecords = this.records.chain(prev.id) ?? []
      if (!chainRecords.length) throw previousResponseNotFound(prev.id, 'its chain is incomplete in the store')
      const identity = chainIdentity(chainRecords[0])
      if (!continues(identity, req)) {
        throw previousResponseNotFound(prev.id, 'instructions, tools or the model changed, which starts a new agy chain; send a create without history')
      }
      input = remapItems(this.withoutOwnReasoning(req.input), prev.callAliases ?? [])
    } else if (segment(req.input).groups.length === 0) {
      chain = newId('chain')
    } else {
      // a full create carrying history: only the records in it can rebuild the conversation
      const match = await this.matchRecords(req)
      chainRecords = match.records
      head = match.head
      if (head === null) {
        throw invalid('input', 'The history carries no usable agy provider record, so its conversation cannot be rebuilt; start a new conversation.', 'provider_record_missing')
      }
      chain = head.chain
      input = match.tail
      if (match.synth.length) {
        throw invalid(
          'input',
          'The history carries responses from another agy chain, which cannot be rebuilt as one conversation; start a new conversation.',
          'provider_record_missing',
        )
      }
    }
    const identity = chainRecords.length ? chainIdentity(chainRecords[0]) : null
    const instructions = identity?.instructions ?? req.instructions
    if (!instructions) throw invalid('instructions', 'Instructions are required.')
    const tools = identity?.tools ?? req.tools
    const model = identity?.model ?? req.model
    const delivery = deliveryFor(head, input)
    const reservation: Reservation = { chain: null }
    const output = new Output({ ...req, instructions, tools, model }, sink)
    let lane: Lane | undefined
    let settled = false
    let patched = 0
    const detach = () => {
      settled = true
      sink.onCancel = null
      this.chains.release(reservation)
      this.active.delete(output.id)
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
    this.assertOpen()
    try {
      this.chains.reserve(chain, reservation)
      const live = this.chains.get(chain)
      const atHead = live !== undefined && !live.dead && !live.busy && live.head === (head?.id ?? null)
      let path: 'new' | 'live' | 'store' | 'history'
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
        await this.chains.evict(chain, 'superseded')
        this.assertOpen()
        lane = this.laneFromRecords(chain, identity!, chainRecords, head, delivery)
        patched = head.end === 'calls' ? head.calls.length : 0
        if (settled) {
          await lane.stop()
          return
        }
        if (!(await lane.start(head.conversation))) {
          throw serverError('store_unreadable', `agy refused the conversation assembled from ${chainRecords.length} provider records.`)
        }
        path = prev ? 'store' : 'history'
      }
      if (settled) {
        await lane.stop()
        return
      }
      this.assertOpen()
      this.report(lane.tier, null)
      output.gateway = { path, chain, conversation: lane.session, records: chainRecords.length, patched }
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
        const notices = req.input.filter((it) => it.kind === 'message') as Extract<InItem, { kind: 'message' }>[]
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
      const prompt = delivery.kind === 'turn' ? delivery.text : (delivery.messages ?? ' ')
      const running = lane
      void running.run(attempt, prompt).catch((e) => {
        console.error('agy response failed', e)
        running.fail(e)
      })
    } catch (e) {
      fail(e)
    }
  }

  /**
   * A continuation's reasoning items are the state `previous_response_id` already names: the gateway's records and
   * agy's own thinking are dropped, and only another lane's record (an old envelope) is refused.
   */
  private withoutOwnReasoning(input: InItem[]): InItem[] {
    const out: InItem[] = []
    for (let i = 0; i < input.length; i++) {
      const item = input[i]
      if (item.kind !== 'reasoning') {
        out.push(item)
        continue
      }
      const content = item.encrypted ?? ''
      if (content.startsWith(AGY_RECORD_PREFIX)) continue
      if (isForeignRecord(content)) {
        throw invalid(`input[${i}]`, "This reasoning item is another lane's provider record, not this agy conversation's state.", 'provider_record_foreign')
      }
    }
    return out
  }

  /** The records of the request's history: the run of responses it continues. */
  private async matchRecords(req: NormRequest): Promise<{ records: AgyRecord[]; head: AgyRecord | null; tail: InItem[]; synth: Group[] }> {
    const { groups } = segment(req.input)
    const match = await matchHistory<AgyRecord, null>(groups, req.input, {
      decode: async (content) => {
        if (content.startsWith(RECORD_PREFIX)) {
          throw invalid('input', "A provider record in the history belongs to the other lane; this gateway continues agy conversations only.", 'provider_record_foreign')
        }
        try {
          return await decodeAgyRecord(content)
        } catch (e) {
          if (!(e instanceof RecordError)) throw e
          if (isForeignRecord(content)) {
            throw invalid('input', `A provider record in the history is not this lane's: ${e.message}.`, 'provider_record_foreign')
          }
          throw invalid('input', `A provider record in the history is malformed: ${e.message}.`, 'provider_record_missing')
        }
      },
      session: (record) => record.conversation,
      continues: (record) => record.instructions === undefined || continues({ instructions: record.instructions, model: record.model!, tools: record.tools! }, req),
      providerCalls: (record) => record.calls.map((call) => call.id),
      state: async () => null,
    })
    const records = match.used.map((used) => used.record)
    return { records, head: records[records.length - 1] ?? null, tail: match.tail, synth: match.synth }
  }

  /** A lane at a record's conversation: the store assembled from the chain's records, with pending calls completed. */
  private laneFromRecords(chain: string, identity: Identity, chainRecords: AgyRecord[], head: AgyRecord, delivery: Delivery): Lane {
    const conversation = head.conversation
    const rows = new Map<number, StepsRow>()
    for (const record of chainRecords) for (const row of record.steps) rows.set(row.idx, stepsRowFromJson(row))
    const trajectory = chainRecords[0].trajectory ? trajectoryFromJson(chainRecords[0].trajectory) : null
    if (!trajectory) {
      throw invalid('input', 'The chain head record carries no trajectory metadata, so its store cannot be rebuilt.', 'provider_record_missing')
    }
    // The output files are written after the store is assembled: assembling replaces the conversation's brain folder,
    // and a step's `file://` result must survive.
    const files: { path: string; content: Uint8Array }[] = []
    if (head.end === 'calls') {
      if (delivery.kind !== 'outputs') throw invalid('input', 'The response holds tool calls whose outputs are missing.', 'missing_tool_output')
      const steps = [...rows.values()].sort((a, b) => a.idx - b.idx)
      const tail = steps.slice(steps.length - head.calls.length)
      for (let i = 0; i < head.calls.length; i++) {
        const row = tail[i]
        const call = head.calls[i]
        if (!row || row.idx !== call.step || row.step_type !== 132 || (row.status !== 1 && row.status !== 2)) {
          throw invalid('input', `The stored tail is not the pending calls this response names (call '${call.id}').`, 'store_mismatch')
        }
        const own = callOf(row)
        if (own?.provider !== call.id) {
          throw invalid('input', `The stored step ${row.idx} does not carry call '${call.id}'.`, 'store_mismatch')
        }
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
    return this.launch(chain, identity.model, identity.instructions, identity.tools)
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
      let lastRecorded = -1
      for (const ancestor of o.chainRecords) {
        for (const row of ancestor.steps) {
          recorded.set(row.idx, stepsHash(row))
          lastRecorded = Math.max(lastRecorded, row.idx)
        }
      }
      // agy only appends steps; a response's own calls are the changed tool-call rows past its parent's last step
      const snapshot = await this.snapshotFor(conversation, o.chainRecords, o.calls.length)
      if (!snapshot) throw serverError('store_unreadable', `agy wrote no conversation store for ${conversation}.`)
      const fresh = snapshot.steps.filter((row) => recorded.get(row.idx) !== stepsHash(stepsRowJson(row)))
      const callSteps = fresh.filter((row) => row.step_type === 132 && row.idx > lastRecorded)
      const refs: CallRef[] = o.calls.map((call, i) => {
        const row = callSteps[i]
        const own = row ? callOf(row) : null
        if (!row || !own || own.tool !== call.name) {
          throw serverError('store_mismatch', `agy's store does not hold a step for tool call '${call.name}'.`)
        }
        return { id: own.provider, name: call.name, step: row.idx }
      })
      const aliases = [...(head?.callAliases ?? [])]
      for (let i = 0; i < refs.length; i++) bindCall(aliases, o.calls[i].callId, refs[i].id)
      const digest = new ItemDigest(remapItems(o.input, aliases)).finish(remapItems(history, aliases))
      record = {
        v: 1,
        id: output.id,
        prev: head?.id ?? null,
        chain: lane.laneId,
        ...(head === null ? { instructions: o.instructions, model: o.model, tools: o.tools } : {}),
        conversation,
        end,
        calls: refs,
        ...(aliases.length ? { callAliases: aliases } : {}),
        ...digest,
        agy: AGY_VERSION,
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
  private async snapshotFor(conversation: string, chainRecords: AgyRecord[], calls: number) {
    const deadline = performance.now() + 2000
    for (;;) {
      const snapshot = this.store.snapshot(conversation)
      if (!snapshot) return null
      if (!calls) return snapshot
      let lastRecorded = -1
      for (const ancestor of chainRecords) for (const row of ancestor.steps) lastRecorded = Math.max(lastRecorded, row.idx)
      const own = snapshot.steps.filter((row) => row.step_type === 132 && row.idx > lastRecorded)
      if (own.length >= calls) return snapshot
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
      this.tokens.delete(lane.token)
    })
    this.chains.add(lane)
    this.tokens.set(lane.token, lane)
    return lane
  }
}

/** Adds a client -> provider call-id pair, keeping the mapping one-to-one and consistent across records. */
function bindCall(aliases: CallAliases, client: string, provider: string): void {
  if (client === provider) return
  const existing = aliases.find(([c]) => c === client)
  if (existing) {
    if (existing[1] !== provider) throw serverError('store_mismatch', `call '${client}' maps to two provider calls`)
    return
  }
  aliases.push([client, provider])
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
  const messages: string[] = []
  const want = new Set(head.calls.map((call) => call.id))
  input.forEach((it, i) => {
    if (it.kind === 'function_call_output') {
      if (!want.has(it.callId)) throw invalid(`input[${i}].call_id`, `No tool call '${it.callId}' is waiting for output.`, 'unexpected_tool_output')
      if (outputs.has(it.callId)) throw invalid(`input[${i}].call_id`, `Duplicate output for '${it.callId}'.`, 'unexpected_tool_output')
      outputs.set(it.callId, text(it.parts))
    } else if (it.kind === 'message' && it.role === 'user') {
      if (it.parts.some((p) => p.type === 'text' && p.text.trim() !== '')) messages.push(text(it.parts))
    } else {
      throw unsupported(`input[${i}]`, 'A delta accepts tool outputs and user messages.')
    }
  })
  const missing = head.calls.filter((call) => !outputs.has(call.id)).map((call) => call.id)
  if (missing.length) throw invalid('input', `Missing outputs for tool calls: ${missing.join(', ')}.`, 'missing_tool_output')
  return { kind: 'outputs', outputs, messages: messages.length ? messages.join('\n\n') : null }
}


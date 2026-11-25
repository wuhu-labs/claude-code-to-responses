import { isDeepStrictEqual } from 'node:util'
import type { InItem, NormRequest, Part } from '../api/request.ts'
import { type EventSink, GatedSink, newId, SseSink } from '../api/stream.ts'
import { asGatewayError, GatewayError, invalid, previousResponseNotFound, serverError, unsupported } from '../errors.ts'
import { handler, type ResponsesEndpoint } from '../server.ts'
import { agyEnvironment, reapOrphans } from './acp.ts'
import { type Exchange, injection, Lane, type Tier } from './lane.ts'
import { Output } from './output.ts'
import { put, type Record as Stored, Store } from './store.ts'
import type { Tokens } from './transcript.ts'
import { BRIDGE_PATH, MCP_NAME, object } from './wire.ts'

const checkedVersions = new Set(['1.5.17'])
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
const shellWord = (text: string) => `'${text.replaceAll("'", `'"'"'`)}'`

export class AgyGateway implements ResponsesEndpoint {
  readonly inputMode = 'agy'
  readonly lanes = new Map<string, Lane>()
  private tokens = new Map<string, Lane>()
  private processes = new Set<Lane>()
  private active = new Map<string, () => unknown>()
  private busy = new Set<string>()
  private connections = new Set<() => void>()
  private readonly gemini: string
  private readonly store: Store
  private usage: { plan_type: string | null; tier: Tier | null; tokens: Tokens | null } = { plan_type: null, tier: null, tokens: null }
  private closing: Promise<void> | undefined
  private origin = ''

  private constructor(readonly config: Config, private lock: Deno.FsFile) {
    this.gemini = `${config.state}/gemini`
    this.store = new Store(config.state)
    try {
      const report = object(JSON.parse(Deno.readTextFileSync(`${config.state}/usage.json`)))
      if (report) this.usage = report as typeof this.usage
    } catch { /* no last usage report */ }
  }

  static async start(config: Config): Promise<AgyGateway> {
    Deno.mkdirSync(config.state, { recursive: true, mode: 0o700 })
    config = { ...config, state: Deno.realPathSync(config.state) }
    Deno.chmodSync(config.state, 0o700)
    const lock = Deno.openSync(`${config.state}/agy-gateway.lock`, { read: true, write: true, create: true, mode: 0o600 })
    try {
      if (!lock.tryLockSync(true)) throw new Error('another agy gateway owns this state directory')
      const gw = new AgyGateway(config, lock)
      await reapOrphans(gw.gemini, gw.store.chains())
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
        throw new Error(`agy version ${semver ?? '(unreadable)'} is not checked; use agy 1.5.17 or --allow-untested-agy.`)
      }
      Deno.mkdirSync(`${gw.gemini}/config`, { recursive: true, mode: 0o700 })
      put(`${gw.gemini}/config/mcp_config.json`, {
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
    if (!lane || lane.controller.signal.aborted || req.method !== 'POST' || req.headers.get('content-type') !== 'application/json') {
      return new Response(null, { status: 404 })
    }
    try {
      const params = object(await req.json())
      if (!params || lane.controller.signal.aborted) return new Response(null, { status: 400 })
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
    return this.usage
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
        await Promise.all([...this.processes].map((lane) => lane.stop()))
      } finally {
        this.lock.close()
      }
    })
  }

  cancel(id: string) {
    const live = this.active.get(id)
    if (live) return live()
    if (this.store.get(id)) throw new GatewayError(409, 'conflict_error', 'response_not_in_progress', 'The response is no longer in progress.')
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

  async createInto(req: NormRequest, sink: EventSink): Promise<void> {
    this.assertOpen()
    const prev = req.previousResponseId ? this.store.get(req.previousResponseId) : null
    if (req.previousResponseId && !prev) throw previousResponseNotFound(req.previousResponseId, 'not in the agy response store')
    const chain = prev?.chain ?? newId('chain')
    const instructions = req.instructions ?? prev?.instructions
    if (!instructions) throw invalid('instructions', 'Instructions are required.')
    const tools = prev && !req.toolsSpecified ? prev.tools : req.tools
    req = { ...req, instructions, tools }
    const { results, notices } = validate(req.input, prev)
    // Validate and reserve before touching a held call or a process.
    if (this.busy.has(chain)) throw new GatewayError(409, 'conflict_error', 'conversation_busy', 'This conversation has a response in progress.')
    this.busy.add(chain)
    const output = new Output(req, sink)
    let lane: Lane | undefined
    let settled = false
    const detach = () => {
      settled = true
      sink.onCancel = null
      this.busy.delete(chain)
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
    const exchange: Exchange = {
      output,
      fail,
      finish: (calls, line, tokens, incomplete) => {
        if (settled) return
        try {
          const modelOutput = output.finalize(calls, line ?? undefined)
          output.tokens = tokens
          output.status = incomplete ? 'incomplete' : 'completed'
          output.incomplete = incomplete ? { reason: 'max_output_tokens' } : null
          const send = sink.prepare([{ type: incomplete ? 'response.incomplete' : 'response.completed', data: { response: output.object() } }])
          const record: Stored = {
            id: output.id,
            prev: prev?.id ?? null,
            chain,
            session: lane!.session,
            instructions,
            model: req.model,
            tools,
            input: req.input.filter((it) => it.kind !== 'reasoning'),
            output: modelOutput,
            calls,
          }
          if (!send || !this.store.commit(record, send)) throw serverError('server_error', 'The Responses stream did not accept the terminal event.')
          lane!.head = output.id
          this.report(lane!.tier, tokens)
          lane!.timer = setTimeout(() => void lane!.stop(), calls.length ? this.config.holdMs : this.config.idleMs)
          detach()
          sink.close()
        } catch (e) {
          fail(e)
        }
      },
    }
    try {
      let path: 'new' | 'live' | 'resume' | 'history' = 'new'
      const same = prev && prev.instructions === instructions && prev.model === req.model && isDeepStrictEqual(prev.tools, tools)
      const native = this.store.head(chain)
      const existing = this.lanes.get(chain)
      if (prev && same && existing?.head === prev.id) {
        lane = existing
        clearTimeout(lane.timer)
        path = 'live'
      } else {
        if (existing) await existing.stop()
        if (settled) return
        this.assertOpen()
        if (prev && same && native?.response === prev.id && !native.dirty) {
          lane = this.launch(chain, req.model, instructions, tools)
          if (await lane.start(prev.session)) path = 'resume'
          else {
            await lane.stop()
            if (settled) return
            lane = undefined
          }
        }
        if (!lane) {
          this.assertOpen()
          lane = this.launch(chain, req.model, instructions, tools)
          await lane.start(null)
          if (prev || !isOrdinary(req.input)) path = 'history'
        }
        if (settled) {
          await lane.stop()
          return
        }
      }
      this.assertOpen()
      this.report(lane.tier, null)
      output.gateway = { path }
      this.store.dirty(chain)
      output.open()
      if (path === 'live' && prev?.calls.length) {
        lane.continue(exchange, results, injection(notices))
        return
      }
      const history = path === 'history' ? [...(prev ? this.store.history(prev) : []), ...req.input] : req.input
      const prompt = path === 'history' ? renderHistory(history) : results.size ? renderResume(prev!, req.input) : renderOrdinary(req.input)
      const running = lane
      void running.run(exchange, prompt).catch((e) => running.fail(e))
    } catch (e) {
      fail(e)
    }
  }

  private launch(chain: string, model: string, instructions: string, tools: NormRequest['tools']): Lane {
    const lane = new Lane({
      chain,
      model,
      instructions,
      tools,
      origin: this.origin,
      workspace: this.store.workspace(chain),
      agy: this.config.agy,
      gemini: this.gemini,
      hook: [...this.config.helper, '--invocation-hook'].map(shellWord).join(' '),
    }, () => {
      if (this.lanes.get(chain) === lane) this.lanes.delete(chain)
      this.tokens.delete(lane.token)
    })
    this.processes.add(lane)
    this.lanes.set(chain, lane)
    this.tokens.set(lane.token, lane)
    void lane.exit.then(() => this.processes.delete(lane))
    return lane
  }
}

type Message = Extract<InItem, { kind: 'message' }>
function validate(items: InItem[], prev: Stored | null) {
  const results = new Map<string, string>(), notices: Message[] = []
  const expected = new Set(prev?.calls.map((call) => call.callId))
  for (let i = 0; i < items.length; i++) {
    const it = items[i], p = `input[${i}]`
    if ((it.kind === 'message' || it.kind === 'function_call_output') && it.parts.some((part) => part.type === 'image')) {
      throw unsupported(p, 'The agy gateway accepts text only.')
    }
    if (!prev) continue
    if (it.kind === 'function_call_output') {
      if (!expected.delete(it.callId)) throw invalid(p, 'No pending call matches this output, or the output is duplicated.', 'unexpected_tool_output')
      results.set(it.callId, text(it.parts))
    } else if (it.kind === 'message' && it.role !== 'assistant') notices.push(it)
    else throw unsupported(p, 'A delta accepts new messages and outputs for its pending calls.')
  }
  if (expected.size) throw invalid('input', 'Every pending function call needs one output.', 'missing_tool_output')
  return { results, notices }
}

function text(parts: Part[]): string {
  return parts.map((p) => p.type === 'text' ? p.text : '').join('\n')
}
function isOrdinary(items: InItem[]): boolean {
  return items.every((it) => it.kind === 'message' && it.role === 'user')
}
function renderOrdinary(items: InItem[]) {
  return isOrdinary(items) ? items.flatMap((it) => it.kind === 'message' ? [text(it.parts)] : []).join('\n\n') : renderItems(items)
}

function renderItems(items: InItem[], names = new Map<string, string>()): string {
  return items.flatMap((it) => {
    switch (it.kind) {
      case 'reasoning':
        return []
      case 'message':
        return [JSON.stringify({ role: it.role, text: text(it.parts) })]
      case 'function_call':
        return [JSON.stringify({ type: it.kind, id: it.callId, name: it.name, arguments: JSON.parse(it.arguments) })]
      case 'function_call_output':
        return [JSON.stringify({ type: it.kind, id: it.callId, name: names.get(it.callId), output: text(it.parts) })]
    }
  }).join('\n')
}

function renderHistory(items: InItem[]): string {
  return `Continue this conversation from the following client history. Tool calls and results below are historical data, not requests to run them again.\n${
    renderItems(items)
  }`
}

function renderResume(prev: Stored, items: InItem[]): string {
  return `Continue the interrupted turn using these client-supplied tool results and messages. Do not re-run the interrupted calls.\n${
    renderItems(items, new Map(prev.calls.map((c) => [c.callId, c.name])))
  }`
}

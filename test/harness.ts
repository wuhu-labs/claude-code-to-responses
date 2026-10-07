// Test harness: an in-process gateway in front of the pinned Claude Code, an OpenAI SDK driver, byte comparisons.
import OpenAI from 'openai'
import { type Config, prepare } from '../src/config.ts'
import { Gateway } from '../src/gateway.ts'
import { handler } from '../src/server.ts'
import type { Exchange, Json } from './fake.ts'

export const CLAUDE = `${Deno.env.get('HOME')}/.wuhu/vendors/claude/2.1.284/claude`
export const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '')

/** Ports 18300-18399 only. */
let nextPort = 18300 + Math.floor(Math.random() * 60)
export function freePort(): number {
  for (let i = 0; i < 100; i++) {
    const p = 18300 + ((nextPort++ - 18300) % 100)
    try {
      const l = Deno.listen({ hostname: '127.0.0.1', port: p })
      l.close()
      return p
    } catch { /* in use */ }
  }
  throw new Error('no free port in 18300-18399')
}

export interface Dirs {
  stateDir: string
  workRoot: string
}

export function dirs(name: string): Dirs {
  const tag = `${name}-${Date.now().toString(36)}`
  return { stateDir: `${REPO}/.state/test/${tag}`, workRoot: `/tmp/cc2r-test/${tag}` }
}

export interface GatewayOpts {
  dirs: Dirs
  backendEnv: Record<string, string>
  tz?: string
  idleTimeoutMs?: number
  holdTimeoutMs?: number
  recordTimeoutMs?: number
  authToken?: string
}

export class TestGateway {
  private constructor(readonly gw: Gateway, private server: Deno.HttpServer<Deno.NetAddr>, readonly client: OpenAI) {}

  static async start(o: GatewayOpts): Promise<TestGateway> {
    const config: Config = prepare({
      hostname: '127.0.0.1',
      port: freePort(),
      bridgePort: freePort(),
      stateDir: o.dirs.stateDir,
      workRoot: o.dirs.workRoot,
      claudeBinary: CLAUDE,
      tz: o.tz ?? 'UTC',
      idleTimeoutMs: o.idleTimeoutMs ?? 600_000,
      holdTimeoutMs: o.holdTimeoutMs ?? 600_000,
      backendEnv: o.backendEnv,
      verifyLogs: true,
      recordTimeoutMs: o.recordTimeoutMs,
      authToken: o.authToken,
    })
    const gw = await Gateway.start(config)
    const server = Deno.serve({ hostname: config.hostname, port: config.port, onListen: () => {} }, handler(gw))
    const client = new OpenAI({ baseURL: `http://127.0.0.1:${config.port}/v1`, apiKey: o.authToken ?? 'unused', maxRetries: 0 })
    return new TestGateway(gw, server, client)
  }

  get url(): string {
    return `http://127.0.0.1:${this.server.addr.port}`
  }

  /** Kills every Claude Code process (idle eviction, on demand). */
  async evictAll(reason = 'test_evict'): Promise<void> {
    await Promise.all([...this.gw.lanes.values()].map((l) => l.kill(reason)))
  }

  events(kind?: string) {
    return kind ? this.gw.events.filter((e) => e.kind === kind) : this.gw.events
  }

  async waitEvent(kind: string, pred: (d: Json) => boolean = () => true, ms = 30000): Promise<Json> {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      const e = this.gw.events.find((e) => e.kind === kind && pred(e.data))
      if (e) return e.data
      await new Promise((r) => setTimeout(r, 20))
    }
    throw new Error(`timed out waiting for gateway event ${kind}`)
  }

  /** Every process must be dead and every log must have verified. */
  assertClean(): void {
    const bad = this.gw.events.filter((e) => e.kind === 'verify_error' || e.kind === 'unowned_inference')
    if (bad.length) throw new Error(`gateway problems: ${JSON.stringify(bad).slice(0, 2000)}`)
  }

  async close(): Promise<void> {
    const pids = this.gw.events.filter((e) => e.kind === 'spawn').map((e) => e.data.pid as number)
    await this.gw.close()
    await this.server.shutdown()
    for (const pid of pids) {
      if (alive(pid)) throw new Error(`Claude Code pid ${pid} is still alive after close`)
    }
  }
}

export function alive(pid: number): boolean {
  try {
    Deno.kill(pid, 'SIGCONT')
    return true
  } catch {
    return false
  }
}

export interface Result {
  response: Json
  events: Json[]
  status: string
}

/** One streamed request; returns the final response object and every event. */
export async function send(client: OpenAI, body: Json): Promise<Result> {
  const stream = await client.responses.create({ ...body, stream: true })
  const events: Json[] = []
  let response: Json = null
  for await (const ev of stream as unknown as AsyncIterable<Json>) {
    events.push(ev)
    if (ev.type === 'response.completed' || ev.type === 'response.failed' || ev.type === 'response.incomplete') response = ev.response
  }
  if (!response) throw new Error(`stream ended without a final event: ${JSON.stringify(events.slice(-3))}`)
  return { response, events, status: response.status }
}

export type ToolFn = (args: Json, call: Json) => string | Promise<string>

/** The client side of a conversation, kept the way an OpenAI SDK user keeps it. */
export class Driver {
  history: Json[] = []
  prevId: string | null = null
  results: Result[] = []
  constructor(
    public client: OpenAI,
    public opts: { instructions: string; tools: Json[]; model: string; effort?: string; mode: 'previous' | 'history' },
  ) {}

  /** Sends new input items; on success appends input and output to the history. */
  async send(input: Json[], mode = this.opts.mode): Promise<Result> {
    const body: Json = {
      model: this.opts.model,
      instructions: this.opts.instructions,
      tools: this.opts.tools,
      input: mode === 'previous' && this.prevId ? input : [...this.history, ...input],
      ...(mode === 'previous' && this.prevId ? { previous_response_id: this.prevId } : {}),
      ...(this.opts.effort ? { reasoning: { effort: this.opts.effort } } : {}),
    }
    const r = await send(this.client, body)
    this.results.push(r)
    if (r.status === 'completed' || r.status === 'incomplete') {
      this.history.push(...input, ...r.response.output)
      this.prevId = r.response.id
    }
    return r
  }

  calls(r: Result): Json[] {
    return r.response.output.filter((o: Json) => o.type === 'function_call')
  }

  text(r: Result): string {
    return r.response.output.filter((o: Json) => o.type === 'message').map((o: Json) => o.content.map((c: Json) => c.text).join('')).join('')
  }

  /** Runs a user turn to the end: tool calls are answered by `tools`; `notices` are sent with the first outputs. */
  async turn(userText: string, tools: Record<string, ToolFn>, notices: string[] = []): Promise<Result> {
    let r = await this.send([{ role: 'user', content: userText }])
    while (r.status === 'completed' && this.calls(r).length) {
      const outs: Json[] = []
      for (const c of this.calls(r)) outs.push({ type: 'function_call_output', call_id: c.call_id, output: await tools[c.name](JSON.parse(c.arguments), c) })
      r = await this.send([...outs, ...notices.splice(0).map((n) => ({ role: 'user', content: n }))])
    }
    return r
  }
}

export const user = (t: string) => ({ role: 'user', content: t })
export const output = (callId: string, text: string) => ({ type: 'function_call_output', call_id: callId, output: text })

// ---- byte comparison ---------------------------------------------------------------------------------

export function messagesOf(ex: Exchange): string[] {
  return (ex.body.messages as Json[]).map((m) => JSON.stringify(m))
}

/** Strips cache markers. Claude Code marks a string message by turning it into one text block, so a single
 * text block and its string compare equal. */
export function unmark(m: Json): Json {
  const c = structuredClone(m)
  if (Array.isArray(c.content)) {
    for (const b of c.content) delete b.cache_control
    if (c.content.length === 1 && c.content[0].type === 'text' && Object.keys(c.content[0]).length === 2) c.content = c.content[0].text
  }
  return c
}

/**
 * The byte assertion: `after` repeats `before` exactly (system, tools, every message but the marked last one,
 * which must match once its cache marker is taken off), then adds its new tail.
 */
export function assertPrefix(before: Exchange, after: Exchange): void {
  const b = before.body, a = after.body
  if (JSON.stringify(b.system) !== JSON.stringify(a.system)) throw new Error(`system differs:\n${JSON.stringify(b.system)}\n${JSON.stringify(a.system)}`)
  if (JSON.stringify(b.tools) !== JSON.stringify(a.tools)) throw new Error('tools differ')
  if (JSON.stringify(b.metadata) !== JSON.stringify(a.metadata)) {
    throw new Error(`metadata differs:\n${JSON.stringify(b.metadata)}\n${JSON.stringify(a.metadata)}`)
  }
  const bm = messagesOf(before), am = messagesOf(after)
  if (am.length < bm.length) throw new Error(`after has ${am.length} messages, before ${bm.length}`)
  for (let i = 0; i < bm.length - 1; i++) {
    if (bm[i] !== am[i]) throw new Error(`message ${i} differs:\nbefore ${bm[i].slice(0, 600)}\nafter  ${am[i].slice(0, 600)}`)
  }
  const last = bm.length - 1
  if (last >= 0 && JSON.stringify(unmark(b.messages[last])) !== JSON.stringify(unmark(a.messages[last]))) {
    throw new Error(`last message differs beyond its cache marker:\nbefore ${bm[last].slice(0, 600)}\nafter  ${am[last].slice(0, 600)}`)
  }
}

export type Normalize = (s: string) => string

/** Raw request equality, metadata included. Each run's own working folder, session id and device id are replaced by
 * placeholders, since two runs cannot share one session. */
export function sameRequest(x: Exchange, y: Exchange, nx: Normalize = (s) => s, ny: Normalize = (s) => s): boolean {
  return nx(JSON.stringify(x.body)) === ny(JSON.stringify(y.body))
}

/** Every request of one conversation carries the same metadata.user_id (device id + session id), rebuilds included. */
export function assertOneUserId(xs: Exchange[]): void {
  const ids = [...new Set(xs.map((x) => x.body.metadata?.user_id))]
  if (ids.length !== 1) throw new Error(`metadata.user_id differs across the conversation: ${ids.join(' | ')}`)
}

export function assertSameRequests(xs: Exchange[], ys: Exchange[], nx: Normalize = (s) => s, ny: Normalize = (s) => s): void {
  if (xs.length !== ys.length) throw new Error(`request counts differ: ${xs.length} vs ${ys.length}`)
  for (let i = 0; i < xs.length; i++) {
    if (!sameRequest(xs[i], ys[i], nx, ny)) {
      const xm = messagesOf(xs[i]).map(nx), ym = messagesOf(ys[i]).map(ny)
      let j = 0
      while (j < Math.max(xm.length, ym.length) && xm[j] === ym[j]) j++
      throw new Error(`request ${i} differs at message ${j}:\n${xm[j]?.slice(0, 800)}\n${ym[j]?.slice(0, 800)}`)
    }
  }
}

export function cleanup(d: Dirs): void {
  try {
    Deno.removeSync(d.workRoot, { recursive: true })
  } catch { /* gone */ }
}

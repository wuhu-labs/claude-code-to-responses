// A fake Anthropic Messages endpoint for byte assertions. Adapted from the research rig (wise-ladder-flag, rig/rig.ts).
// Every request is recorded raw; replies come from a queue the test fills, so a scenario run twice gets the same replies.

// deno-lint-ignore no-explicit-any
export type Json = any

export type Block =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'tool_use'; id: string; name: string; input: Json }

export interface Exchange {
  n: number
  path: string
  kind: 'main' | 'side' | 'count_tokens' | 'other'
  raw: string
  body: Json
  headers: Record<string, string>
}

export interface Reply {
  blocks: Block[]
  stop?: string
  usage?: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; output_tokens?: number }
  /** ms to wait between content blocks while streaming */
  gapMs?: number
}

export class FakeAnthropic {
  exchanges: Exchange[] = []
  queue: (Reply | ((ex: Exchange) => Reply))[] = []
  /** Called when the queue is empty. */
  fallback: (ex: Exchange) => Reply = () => ({ blocks: [{ type: 'text', text: 'FAKE-DEFAULT' }] })
  private server: Deno.HttpServer<Deno.NetAddr>
  private waiters: { n: number; resolve: () => void }[] = []

  constructor(port: number) {
    this.server = Deno.serve({ hostname: '127.0.0.1', port, onListen: () => {} }, (r) => this.handle(r))
  }

  get url(): string {
    return `http://127.0.0.1:${this.server.addr.port}`
  }

  main(): Exchange[] {
    return this.exchanges.filter((e) => e.kind === 'main')
  }

  /** Resolves once `n` main requests have arrived. */
  waitMain(n: number): Promise<void> {
    if (this.main().length >= n) return Promise.resolve()
    return new Promise((resolve) => this.waiters.push({ n, resolve }))
  }

  reply(...r: (Reply | ((ex: Exchange) => Reply))[]): void {
    this.queue.push(...r)
  }

  async close(): Promise<void> {
    await this.server.shutdown()
  }

  private async handle(req: Request): Promise<Response> {
    const raw = await req.text()
    let body: Json = {}
    try {
      body = raw ? JSON.parse(raw) : {}
    } catch { /* not json */ }
    const u = new URL(req.url)
    const headers: Record<string, string> = {}
    req.headers.forEach((v, k) => (headers[k] = v))
    const kind: Exchange['kind'] = u.pathname.includes('count_tokens')
      ? 'count_tokens'
      : !u.pathname.startsWith('/v1/messages')
      ? 'other'
      : Array.isArray(body.system) && JSON.stringify(body.system).includes('Agent SDK')
      ? 'main'
      : 'side'
    const ex: Exchange = { n: this.exchanges.length + 1, path: u.pathname + u.search, kind, raw, body, headers }
    this.exchanges.push(ex)
    if (kind === 'main') {
      const count = this.main().length
      for (const w of this.waiters.filter((w) => w.n <= count)) {
        this.waiters.splice(this.waiters.indexOf(w), 1)
        w.resolve()
      }
    }
    if (kind === 'other') return Response.json({}, { status: 404 })
    if (kind === 'count_tokens') return Response.json({ input_tokens: Math.max(1, raw.length >> 2) })
    let r: Reply
    if (kind === 'side') r = { blocks: [{ type: 'text', text: 'FAKE-SIDE' }] }
    else {
      const q = this.queue.shift()
      r = q === undefined ? this.fallback(ex) : typeof q === 'function' ? q(ex) : q
    }
    const usage = {
      input_tokens: r.usage?.input_tokens ?? Math.max(1, raw.length >> 2),
      cache_creation_input_tokens: r.usage?.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: r.usage?.cache_read_input_tokens ?? 0,
      output_tokens: r.usage?.output_tokens ?? 20,
    }
    const stop = r.stop ?? (r.blocks.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn')
    const message = {
      id: `msg_fake_${ex.n}`,
      type: 'message',
      role: 'assistant',
      model: body.model ?? 'fake',
      content: r.blocks,
      stop_reason: stop,
      stop_sequence: null,
      usage,
    }
    if (!body.stream) return Response.json(message)
    const events = sseEvents(message)
    const gap = r.gapMs ?? 0
    const stream = new ReadableStream<Uint8Array>({
      async start(c) {
        const enc = new TextEncoder()
        for (const e of events) {
          c.enqueue(enc.encode(e))
          if (gap && e.startsWith('event: content_block_stop')) await new Promise((res) => setTimeout(res, gap))
        }
        c.close()
      },
    })
    return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
  }
}

export function sseEvents(message: Json): string[] {
  const ev = (name: string, data: Json) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`
  const out = [
    ev('message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null, usage: { ...message.usage, output_tokens: 1 } } }),
  ]
  message.content.forEach((b: Block, index: number) => {
    let start: Json, deltas: Json[]
    if (b.type === 'text') {
      start = { type: 'text', text: '' }
      deltas = [{ type: 'text_delta', text: b.text }]
    } else if (b.type === 'thinking') {
      start = { type: 'thinking', thinking: '', signature: '' }
      deltas = [{ type: 'thinking_delta', thinking: b.thinking }, { type: 'signature_delta', signature: b.signature }]
    } else {
      start = { type: 'tool_use', id: b.id, name: b.name, input: {} }
      deltas = [{ type: 'input_json_delta', partial_json: JSON.stringify(b.input) }]
    }
    out.push(ev('content_block_start', { type: 'content_block_start', index, content_block: start }))
    for (const d of deltas) out.push(ev('content_block_delta', { type: 'content_block_delta', index, delta: d }))
    out.push(ev('content_block_stop', { type: 'content_block_stop', index }))
  })
  out.push(ev('message_delta', { type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: message.usage }))
  out.push(ev('message_stop', { type: 'message_stop' }))
  return out
}

export const text = (t: string): Block => ({ type: 'text', text: t })
export const think = (t: string): Block => ({ type: 'thinking', thinking: t, signature: `SIG-${t}` })
export const call = (id: string, name: string, input: Json): Block => ({ type: 'tool_use', id, name: `mcp__fn__${name}`, input })

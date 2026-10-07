// The loopback MCP server and hook endpoint every Claude Code process talks to. Each process gets its own epoch:
// a random path segment that dies with the process, so a call from a killed process can never reach its successor.
import { newId } from './api/stream.ts'

// deno-lint-ignore no-explicit-any
type Json = any

export interface BridgeTarget {
  mcpTools(): Json[]
  /** Resolves with the MCP tools/call result once the client's output arrives. */
  toolCall(callId: string, name: string, args: Json, signal: AbortSignal): Promise<Json>
  hook(body: Json): Json
}

export class Bridge {
  readonly bearer = newId('brg')
  private targets = new Map<string, BridgeTarget>()
  private server: Deno.HttpServer<Deno.NetAddr>
  /** Requests rejected because their epoch was not live (stale calls from killed processes). */
  fenced: { epoch: string; kind: string; at: number }[] = []

  constructor(port = 0) {
    this.server = Deno.serve({ hostname: '127.0.0.1', port, onListen: () => {} }, (r) => this.handle(r))
  }

  get url(): string {
    return `http://127.0.0.1:${this.server.addr.port}`
  }

  mcpUrl(epoch: string): string {
    return `${this.url}/mcp/${epoch}`
  }

  hookUrl(epoch: string): string {
    return `${this.url}/hook/${epoch}`
  }

  register(epoch: string, t: BridgeTarget): void {
    this.targets.set(epoch, t)
  }

  unregister(epoch: string): void {
    this.targets.delete(epoch)
  }

  async close(): Promise<void> {
    await this.server.shutdown()
  }

  private async handle(req: Request): Promise<Response> {
    if (req.headers.get('authorization') !== `Bearer ${this.bearer}`) return new Response(null, { status: 401 })
    const m = /^\/(mcp|hook)\/([A-Za-z0-9_]+)$/.exec(new URL(req.url).pathname)
    if (!m) return new Response(null, { status: 404 })
    const [, kind, epoch] = m
    if (req.method !== 'POST') return new Response(null, { status: 405 })
    const target = this.targets.get(epoch)
    let body: Json
    try {
      body = await req.json()
    } catch {
      return new Response(null, { status: 400 })
    }
    if (!target) {
      this.fenced.push({ epoch, kind, at: Date.now() })
      if (kind === 'hook') return Response.json({}, { status: 410 })
      return Response.json({ jsonrpc: '2.0', id: body?.id ?? null, error: { code: -32001, message: 'stale Claude Code process: this epoch is gone' } }, {
        status: 410,
      })
    }
    if (kind === 'hook') return Response.json(target.hook(body))
    if (body?.id === undefined || body?.id === null) return new Response(null, { status: 202 })
    const reply = (result: Json) => Response.json({ jsonrpc: '2.0', id: body.id, result })
    const fail = (code: number, message: string) => Response.json({ jsonrpc: '2.0', id: body.id, error: { code, message } })
    switch (body.method) {
      case 'initialize':
        return reply({
          protocolVersion: body.params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'claude-code-to-responses', version: '1' },
        })
      case 'ping':
        return reply({})
      case 'tools/list':
        return reply({ tools: target.mcpTools() })
      case 'tools/call': {
        const p = body.params ?? {}
        const callId = p._meta?.['claudecode/toolUseId']
        if (typeof callId !== 'string' || !callId) return fail(-32602, 'tools/call without claudecode/toolUseId')
        try {
          return reply(await target.toolCall(callId, String(p.name), p.arguments ?? {}, req.signal))
        } catch (e) {
          return fail(-32000, e instanceof Error ? e.message : String(e))
        }
      }
      default:
        return fail(-32601, `method not found: ${body.method}`)
    }
  }
}

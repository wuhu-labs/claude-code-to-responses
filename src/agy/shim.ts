import { lines } from '../claude/lines.ts'
import { BRIDGE_PATH, MCP_NAME, object, rpc, rpcError, rpcId, string } from './wire.ts'

/** The subprocess never has a tool implementation or access to another lane's token. */
export async function runShim(mode: '--mcp-shim' | '--invocation-hook'): Promise<void> {
  const token = Deno.env.get('AGY_RESPONSES_LANE')
  const address = Deno.env.get('AGY_RESPONSES_ORIGIN')
  if (!token || !address || !/^http:\/\/127\.0\.0\.1:\d+$/.test(address)) throw new Error('missing agy lane credentials')
  const abort = new AbortController()
  async function bridge(operation: 'list' | 'call' | 'hook', params: unknown) {
    const signal = operation === 'call' ? abort.signal : AbortSignal.any([abort.signal, AbortSignal.timeout(5000)])
    const res = await fetch(`${address}${BRIDGE_PATH}/${operation}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(params),
      signal,
    })
    if (!res.ok) throw new Error('agy lane is unavailable')
    return await res.json()
  }
  const writer = Deno.stdout.writable.getWriter()
  const send = (value: unknown) => writer.write(new TextEncoder().encode(JSON.stringify(value) + '\n'))
  if (mode === '--invocation-hook') {
    const input = await new Response(Deno.stdin.readable).json()
    await send(await bridge('hook', input))
    return
  }
  const inFlight = new Set<Promise<void>>()
  // Keep draining stdin while a call is held. A killed agy closes the pipe and aborts the hold.
  for await (const line of lines(Deno.stdin.readable)) {
    let msg
    try {
      msg = object(JSON.parse(line))
    } catch {
      continue
    }
    const id = rpcId(msg?.id)
    if (id === undefined) continue
    const params = object(msg?.params) ?? {}
    const reply = async () => {
      switch (msg?.method) {
        case 'initialize':
          return rpc(id, {
            protocolVersion: string(params.protocolVersion) ?? '2025-11-25',
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: MCP_NAME, version: '1.0.0' },
          })
        case 'ping':
          return rpc(id, {})
        case 'tools/list':
          return rpc(id, await bridge('list', {}))
        case 'tools/call':
          return rpc(id, await bridge('call', params))
        default:
          return rpcError(id, -32601, 'Method not found')
      }
    }
    const task = reply().catch(() => rpcError(id, -32000, 'agy lane is unavailable')).then(async (value) => {
      if (!abort.signal.aborted) await send(value)
    }).catch(() => abort.abort()).finally(() => inFlight.delete(task))
    inFlight.add(task)
  }
  abort.abort()
  await Promise.allSettled(inFlight)
}

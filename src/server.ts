// HTTP routes: POST /v1/responses (SSE), POST /v1/responses/{id}/cancel, GET /healthz.
import { parseRequest } from './api/request.ts'
import { asGatewayError, GatewayError, invalid } from './errors.ts'
import type { Gateway } from './gateway.ts'

function sameToken(given: string, want: string): boolean {
  const a = new TextEncoder().encode(given), b = new TextEncoder().encode(want)
  let diff = a.length ^ b.length
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0)
  return diff === 0
}

export function handler(gw: Gateway): (req: Request) => Promise<Response> {
  return async (req) => {
    const url = new URL(req.url)
    try {
      const token = gw.config.authToken
      if (token !== undefined) {
        const given = /^Bearer (.+)$/.exec(req.headers.get('authorization') ?? '')?.[1] ?? ''
        if (!sameToken(given, token)) throw new GatewayError(401, 'invalid_request_error', 'invalid_api_key', 'Missing or wrong bearer token.')
      }
      if (req.method === 'GET' && url.pathname === '/healthz') return Response.json({ ok: true, lanes: gw.lanes.size })
      if (req.method === 'POST' && url.pathname === '/v1/responses') {
        let body: unknown
        try {
          body = await req.json()
        } catch {
          throw invalid(null, 'The request body is not valid JSON.')
        }
        const stream = await gw.create(parseRequest(body))
        return new Response(stream, { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' } })
      }
      const m = /^\/v1\/responses\/([A-Za-z0-9_-]+)\/cancel$/.exec(url.pathname)
      if (req.method === 'POST' && m) return Response.json(gw.cancel(m[1]))
      throw new GatewayError(404, 'not_found_error', 'not_found', `No route for ${req.method} ${url.pathname}.`)
    } catch (e) {
      const err = asGatewayError(e)
      if (err.status >= 500) console.error('request failed', err)
      return Response.json(err.toJSON(), { status: err.status })
    }
  }
}

import { GatewayError, serverError } from '../errors.ts'
import { rateLimitError, type RateLimitInfo } from '../usage.ts'
import type { Frame } from './process.ts'

const TRANSIENT_TRANSPORT_RESULTS = new Set(['Request timed out', 'API Error: Connection dropped (ECONNRESET)'])

/** Status-less first-byte stalls carry `api_error: no_response` on the synthetic assistant, not the result. */
export function isNoResponseFrame(f: Frame): boolean {
  return f.type === 'assistant' && f.is_api_error_message === true && f.error === 'server_error' &&
    f.api_error === 'no_response' && f.message?.model === '<synthetic>'
}
export function resultError(f: Frame, rateLimit: RateLimitInfo | null, noResponse = false): GatewayError {
  const text = String(f.result ?? f.errors?.join?.('; ') ?? 'Claude Code reported an error')
  // the local blocking limit, or the backend refusing the prompt as too long ("prompt is too long: N tokens > M maximum")
  if (f.terminal_reason === 'blocking_limit' || /prompt is too long/i.test(text)) {
    return new GatewayError(400, 'invalid_request_error', 'context_length_exceeded', `The context is too long for the model: ${text}`)
  }
  const status = typeof f.api_error_status === 'number' ? f.api_error_status : null
  if (f.terminal_reason === 'api_error' && status !== null) {
    if (status === 429) return rateLimitError(text, rateLimit)
    if (status === 401 || status === 403) return new GatewayError(status, 'server_error', 'upstream_authentication_error', text)
    if (Number.isInteger(status) && status >= 500 && status < 600) return serverError('server_error', text)
    if (status >= 400 && status < 500) return new GatewayError(400, 'invalid_request_error', 'upstream_invalid_request', text)
    return new GatewayError(502, 'server_error', 'upstream_error', text)
  }
  if (f.terminal_reason === 'api_error' && f.api_error_status == null && (noResponse || TRANSIENT_TRANSPORT_RESULTS.has(text))) {
    return serverError('server_error', text)
  }
  return serverError('claude_code_error', `Claude Code ended the turn with an error (${f.terminal_reason ?? 'unknown'}): ${text}`)
}

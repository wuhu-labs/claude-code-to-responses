// Typed errors in the OpenAI error shape: {"error": {"message", "type", "param", "code"}}.
// Nothing the gateway can't do is ever papered over: it is one of these.

export type ErrorType = 'invalid_request_error' | 'not_found_error' | 'conflict_error' | 'server_error'

/** Every error code the gateway can answer with. README.md documents each (a test checks it). */
export const ERROR_CODES = [
  // the request
  'invalid_request',
  'unsupported',
  'invalid_api_key',
  'previous_response_not_found',
  'invalid_function_arguments',
  'invalid_provider_record',
  'unexpected_reasoning_item',
  'missing_tool_output',
  'unexpected_tool_output',
  'tool_output_too_large',
  'image_too_large',
  'conversation_busy',
  'websocket_response_in_progress',
  'websocket_message_too_large',
  'websocket_backpressure',
  'not_found',
  'response_not_in_progress',
  'shutting_down',
  // the response
  'cancelled',
  'context_length_exceeded',
  'upstream_invalid_request',
  'upstream_authentication_error',
  'rate_limit_exceeded',
  'upstream_overloaded',
  'upstream_error',
  'upstream_stream_cut',
  'malformed_model_message',
  'unexpected_block',
  'unexpected_control_request',
  'turn_ended_without_message',
  'notice_undelivered',
  'record_incomplete',
  'claude_code_exited',
  'claude_code_killed',
  'claude_code_stdin',
  'claude_code_error',
  'internal_error',
] as const
export type ErrorCode = typeof ERROR_CODES[number]

export class GatewayError extends Error {
  constructor(
    readonly status: number,
    readonly type: ErrorType,
    readonly code: ErrorCode,
    message: string,
    readonly param: string | null = null,
  ) {
    super(message)
    this.name = 'GatewayError'
  }

  toJSON() {
    return { error: { message: this.message, type: this.type, param: this.param, code: this.code } }
  }

  /** The `error` object of a failed response (`response.failed`). */
  toResponseError() {
    return { code: this.code, message: this.message }
  }
}

/** A field or value outside the supported subset of the Responses API. */
export function unsupported(param: string, message: string): GatewayError {
  return new GatewayError(400, 'invalid_request_error', 'unsupported', message, param)
}

export function invalid(param: string | null, message: string, code: ErrorCode = 'invalid_request'): GatewayError {
  return new GatewayError(400, 'invalid_request_error', code, message, param)
}

/** The client must send the full history instead of a previous response id. */
export function previousResponseNotFound(id: string, why: string): GatewayError {
  return new GatewayError(
    400,
    'invalid_request_error',
    'previous_response_not_found',
    `Previous response with id '${id}' not found: ${why}. Send the full history instead.`,
    'previous_response_id',
  )
}

export function serverError(code: ErrorCode, message: string): GatewayError {
  return new GatewayError(500, 'server_error', code, message)
}

export function asGatewayError(e: unknown): GatewayError {
  if (e instanceof GatewayError) return e
  return serverError('internal_error', e instanceof Error ? e.message : String(e))
}

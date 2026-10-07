// Typed errors in the OpenAI error shape: {"error": {"message", "type", "param", "code"}}.
// Nothing the gateway can't do is ever papered over: it is one of these.

export type ErrorType = 'invalid_request_error' | 'not_found_error' | 'conflict_error' | 'server_error'

export class GatewayError extends Error {
  constructor(
    readonly status: number,
    readonly type: ErrorType,
    readonly code: string,
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

export function invalid(param: string | null, message: string, code = 'invalid_request'): GatewayError {
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

export function serverError(code: string, message: string): GatewayError {
  return new GatewayError(500, 'server_error', code, message)
}

export function asGatewayError(e: unknown): GatewayError {
  if (e instanceof GatewayError) return e
  return serverError('internal_error', e instanceof Error ? e.message : String(e))
}

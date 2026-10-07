// OpenAI Responses WebSocket subset: one create in flight, text JSON events, no cancel message.
import { parseRequest } from './api/request.ts'
import type { EventSink, SinkEvent } from './api/stream.ts'
import { asGatewayError, GatewayError, invalid, unsupported } from './errors.ts'
import type { Gateway } from './gateway.ts'

type Json = any

export const WS_MAX_MESSAGE_BYTES = 16 * 1024 * 1024
export const WS_MAX_BUFFERED_BYTES = 16 * 1024 * 1024
export const WS_DRAIN_TIMEOUT_MS = 5000

/** A bounded socket writer. Never await a peer from the Claude Code lane. Even after a terminal event, a
 * stalled socket is closed within the drain deadline; the lane has already been released for other transports. */
export class SocketWriter {
  private timer: ReturnType<typeof setInterval> | undefined
  private pendingSince: number | null = null
  private stopped = false
  private lastBuffered = 0
  onDisconnect: (() => void) | null = null

  constructor(private socket: WebSocket) {}

  get isClosed(): boolean {
    return this.stopped || this.socket.readyState !== WebSocket.OPEN
  }

  send(event: Json): boolean {
    return this.prepare([event])?.() ?? false
  }

  prepare(events: Json[]): (() => boolean) | null {
    if (this.isClosed) return null
    const texts = events.map((event) => JSON.stringify(event))
    const sizes = texts.map((text) => new TextEncoder().encode(text).byteLength)
    if (sizes.some((size) => size > WS_MAX_MESSAGE_BYTES)) {
      this.fail(new GatewayError(413, 'server_error', 'websocket_message_too_large', 'The outbound event exceeds the 16 MiB message limit.'), 1009)
      return null
    }
    const size = sizes.reduce((total, n) => total + n, 0)
    if (!this.hasCapacity(size)) return null
    return () => {
      if (this.isClosed || !this.hasCapacity(size)) return false
      const before = this.socket.bufferedAmount
      if (before < this.lastBuffered) this.pendingSince = Date.now() // real draining progress
      try {
        for (const text of texts) this.socket.send(text)
      } catch {
        this.disconnect()
        return false
      }
      this.watchDrain()
      return true
    }
  }

  private hasCapacity(size: number): boolean {
    if (size + this.socket.bufferedAmount <= WS_MAX_BUFFERED_BYTES) return true
    this.fail(new GatewayError(429, 'server_error', 'websocket_backpressure', 'The client is not draining the bounded WebSocket output buffer.'), 1013)
    return false
  }

  private watchDrain(): void {
    this.lastBuffered = this.socket.bufferedAmount
    if (!this.timer && this.socket.bufferedAmount > 0) {
      this.pendingSince = Date.now()
      this.timer = setInterval(() => {
        const buffered = this.socket.bufferedAmount
        if (buffered === 0) {
          this.clearTimer()
        } else if (buffered < this.lastBuffered) {
          this.pendingSince = Date.now()
        } else if (Date.now() - this.pendingSince! >= WS_DRAIN_TIMEOUT_MS) {
          this.fail(new GatewayError(429, 'server_error', 'websocket_backpressure', 'The client did not drain WebSocket output within 5 seconds.'), 1013)
        }
        this.lastBuffered = buffered
      }, 25)
    }
  }

  error(err: GatewayError): void {
    this.send({ type: 'error', status: err.status, ...err.toJSON() })
  }

  /** A fatal transport error gets one small best-effort typed event, then close. A non-reading peer cannot be
   * guaranteed to receive that event. No writes or timers survive closure, even if it never answers close. */
  fail(err: GatewayError, code: number): void {
    if (this.stopped) return
    if (this.socket.readyState === WebSocket.OPEN) {
      try {
        this.socket.send(JSON.stringify({ type: 'error', status: err.status, ...err.toJSON() }))
        this.socket.close(code, err.code)
      } catch { /* transport already gone */ }
    }
    this.disconnect()
  }

  shutdown(): void {
    try {
      this.socket.close(1001, 'shutting_down')
    } catch { /* already gone */ }
    this.disconnect()
  }

  disconnect(): void {
    if (this.stopped) return
    this.stopped = true
    this.clearTimer()
    // Fence the writer immediately, but do not re-enter a lane in the middle of its event emission.
    queueMicrotask(() => this.onDisconnect?.())
  }

  private clearTimer(): void {
    clearInterval(this.timer)
    this.timer = undefined
    this.pendingSince = null
  }
}

class SocketSink implements EventSink {
  onCancel: (() => void) | null = null
  private seq = 0
  private closed = false
  constructor(private writer: SocketWriter, private done: () => void) {}

  get isClosed(): boolean {
    return this.closed || this.writer.isClosed
  }

  send(type: string, data: Json): void {
    this.prepare([{ type, data }])?.()
  }

  prepare(events: SinkEvent[]): (() => boolean) | null {
    if (this.isClosed) return null
    const send = this.writer.prepare(events.map(({ type, data }, i) => ({ type, sequence_number: this.seq + i, ...data })))
    if (!send) return null
    return () => {
      if (this.isClosed || !send()) return false
      this.seq += events.length
      return true
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.done()
  }

  cancel(): void {
    if (this.closed) return
    this.closed = true
    this.onCancel?.()
  }
}

export function upgradeResponses(req: Request, gw: Gateway): Response {
  gw.assertOpen()
  if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') throw invalid(null, 'GET /v1/responses requires a WebSocket upgrade.')
  let socket: WebSocket, response: Response
  try {
    ;({ socket, response } = Deno.upgradeWebSocket(req))
  } catch {
    throw invalid(null, 'Invalid WebSocket upgrade request.')
  }
  const writer = new SocketWriter(socket)
  let active: SocketSink | null = null
  // Reserve synchronously, before parse/hash/store work yields. Rejected creates never touch a lane.
  const untrack = gw.trackConnection(() => writer.shutdown())
  writer.onDisconnect = () => {
    untrack()
    active?.cancel()
  }
  socket.onclose = socket.onerror = () => writer.disconnect()
  socket.onmessage = (message) => {
    if (writer.isClosed) return
    const size = typeof message.data === 'string'
      ? new TextEncoder().encode(message.data).byteLength
      : message.data instanceof Blob
      ? message.data.size
      : message.data.byteLength
    if (size > WS_MAX_MESSAGE_BYTES) {
      writer.fail(new GatewayError(413, 'invalid_request_error', 'websocket_message_too_large', 'The message exceeds the 16 MiB limit.'), 1009)
      return
    }
    if (typeof message.data !== 'string') {
      writer.error(unsupported('type', 'Only JSON text messages are supported.'))
      return
    }
    try {
      let event: Json
      try {
        event = JSON.parse(message.data)
      } catch {
        throw invalid(null, 'The WebSocket message is not valid JSON.')
      }
      if (typeof event !== 'object' || event === null || Array.isArray(event)) throw invalid(null, 'The WebSocket event must be an object.')
      if (event.type !== 'response.create') throw unsupported('type', "Only 'response.create' is supported; there is no cancel message.")
      if (active) throw new GatewayError(409, 'conflict_error', 'websocket_response_in_progress', 'One response is already in flight on this connection.')
      const { type: _type, ...body } = event
      const parsed = parseRequest(body, 'websocket')
      const sink = new SocketSink(writer, () => {
        if (active === sink) active = null
      })
      active = sink
      void gw.createInto(parsed, sink).catch((e) => {
        writer.error(asGatewayError(e))
        sink.close()
      })
    } catch (e) {
      writer.error(asGatewayError(e))
    }
  }
  return response
}

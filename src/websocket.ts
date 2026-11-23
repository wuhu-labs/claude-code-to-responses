import { RECORD_PREFIX } from './records.ts'
import { Buffer } from 'node:buffer'
// OpenAI Responses WebSocket subset: one create in flight, text JSON events, no cancel message.
import { parseWebSocketCreate, WARMUP_ID_STEM, type WarmupPrefix } from './api/request.ts'
import { type EventSink, GatedSink, newId, ResponseState, type SinkEvent } from './api/stream.ts'
import { asGatewayError, GatewayError, invalid, previousResponseNotFound, serverError, unsupported } from './errors.ts'
import type { Gateway } from './gateway.ts'

type Json = any

export const WS_MAX_MESSAGE_BYTES = 128 * 1024 * 1024
export const WS_MAX_BUFFERED_BYTES = 128 * 1024 * 1024
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
    const sizes = texts.map((text) => Buffer.byteLength(text))
    if (sizes.some((size) => size > WS_MAX_MESSAGE_BYTES)) {
      this.fail(
        new GatewayError(
          413,
          'invalid_request_error',
          'response_too_large',
          `The response event requires ${Math.max(...sizes)} bytes; the message limit is ${WS_MAX_MESSAGE_BYTES} bytes.`,
        ),
        1009,
      )
      return null
    }
    const size = sizes.reduce((total, n) => total + n, 0)
    if (size > WS_MAX_BUFFERED_BYTES) {
      this.fail(
        new GatewayError(
          413,
          'invalid_request_error',
          'response_too_large',
          `The response batch requires ${size} bytes; the output limit is ${WS_MAX_BUFFERED_BYTES} bytes.`,
        ),
        1009,
      )
      return null
    }
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
    this.fail(serverError('server_error', 'The client is not draining the bounded WebSocket output buffer.'), 1011)
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
          this.fail(serverError('server_error', 'The client did not drain WebSocket output within 5 seconds.'), 1011)
        }
        this.lastBuffered = buffered
      }, 25)
    }
  }

  /** The typed `error` event: the HTTP status, the error object, and the HTTP headers (`retry-after`) when any. */
  error(err: GatewayError): void {
    this.send(errorEvent(err))
  }

  /** A fatal transport error gets one small best-effort typed event, then close. A non-reading peer cannot be
   * guaranteed to receive that event. No writes or timers survive closure, even if it never answers close. */
  fail(err: GatewayError, code: number): void {
    if (this.stopped) return
    if (this.socket.readyState === WebSocket.OPEN) {
      try {
        this.socket.send(JSON.stringify(errorEvent(err)))
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

function errorEvent(err: GatewayError): Json {
  return { type: 'error', status: err.status, ...err.toJSON(), ...(Object.keys(err.headers).length ? { headers: err.headers } : {}) }
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
    const send = this.writer.prepare(events.map(({ type, data }, i) => {
      if (type === 'response.completed' || type === 'response.incomplete') {
        const output = data.response.output?.map((item: Json) => {
          if (item.type !== 'reasoning' || !item.encrypted_content?.startsWith(RECORD_PREFIX)) return item
          const { encrypted_content: _, ...rest } = item
          return rest
        })
        data = { ...data, response: { ...data.response, output } }
      }
      return { type, sequence_number: this.seq + i, ...data }
    }))
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

  /** Out of the response's sequence, so it carries no `sequence_number`; it outlives the response with the socket. */
  metadata(event: Json): void {
    if (!this.writer.isClosed) this.writer.send(event)
  }

  cancel(): void {
    if (this.closed) return
    this.closed = true
    try {
      this.onCancel?.()
    } finally {
      // cancel marks the sink closed before notifying the lane, so its re-entrant close cannot release
      // the single-flight slot. Release it here even for a socket lost during asynchronous planning.
      this.done()
    }
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
  const warmups = new Map<string, { prefix: WarmupPrefix; bytes: number }>()
  let warmupBytes = 0
  // Reserve synchronously, before parse/hash/store work yields. Rejected creates never touch a lane.
  const untrack = gw.trackConnection(() => writer.shutdown())
  writer.onDisconnect = () => {
    untrack()
    warmups.clear()
    active?.cancel()
  }
  socket.onclose = socket.onerror = () => writer.disconnect()
  socket.onmessage = (message) => {
    if (writer.isClosed) return
    const size = typeof message.data === 'string' ? Buffer.byteLength(message.data) : message.data instanceof Blob ? message.data.size : message.data.byteLength
    if (size > WS_MAX_MESSAGE_BYTES) {
      writer.fail(new GatewayError(413, 'invalid_request_error', 'websocket_message_too_large', 'The message exceeds the 128 MiB limit.'), 1009)
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
      const previous = warmups.get(body.previous_response_id)
      const create = parseWebSocketCreate(body, previous?.prefix)
      if (create.kind === 'warmup') {
        const { req, prefix } = create
        if (req.previousResponseId !== null && !gw.store.has(req.previousResponseId)) {
          throw previousResponseNotFound(req.previousResponseId, "it is not in this gateway's store")
        }
        const bytes = size + (previous?.bytes ?? 0)
        if (warmupBytes + bytes > WS_MAX_MESSAGE_BYTES) {
          throw new GatewayError(413, 'invalid_request_error', 'warmup_limit_exceeded', 'This connection has reached its warm-up input limit.')
        }
        const sink = new SocketSink(writer, () => {})
        const state = new ResponseState(req, newId(WARMUP_ID_STEM))
        const started = { ...state.object(), store: false }
        state.status = 'completed'
        state.usage = { input: 0, cacheRead: 0, cacheCreation: 0, output: 0 }
        if (
          sink.prepare([
            { type: 'response.created', data: { response: started } },
            { type: 'response.completed', data: { response: { ...state.object(), store: false } } },
          ])?.()
        ) {
          warmups.set(state.id, { prefix, bytes })
          warmupBytes += bytes
        }
        return
      }
      const inner = new SocketSink(writer, () => {
        if (active === inner) active = null
      })
      active = inner
      // a 429 before any output is the typed error event, not a response that failed
      const sink = new GatedSink(inner, { refused: (err) => writer.error(err) })
      void gw.createInto(create.req, sink).catch((e) => {
        writer.error(asGatewayError(e))
        sink.close()
      })
    } catch (e) {
      writer.error(asGatewayError(e))
    }
  }
  return response
}

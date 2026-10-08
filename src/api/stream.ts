// The response object and its server-sent events, in OpenAI's Responses streaming shape.
import type { GatewayError } from '../errors.ts'
import type { NormRequest } from './request.ts'

// deno-lint-ignore no-explicit-any
type Json = any

export function newId(prefix: string): string {
  const b = new Uint8Array(16)
  crypto.getRandomValues(b)
  return `${prefix}_${Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')}`
}

export interface UsageTotals {
  input: number
  cacheRead: number
  cacheCreation: number
  output: number
}

export function usageObject(u: UsageTotals) {
  const input = u.input + u.cacheRead + u.cacheCreation
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: u.cacheRead },
    output_tokens: u.output,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: input + u.output,
    // Anthropic's raw numbers, summed over the model messages of this response.
    anthropic: {
      input_tokens: u.input,
      cache_read_input_tokens: u.cacheRead,
      cache_creation_input_tokens: u.cacheCreation,
      output_tokens: u.output,
    },
  }
}

export type Status = 'in_progress' | 'completed' | 'failed' | 'incomplete' | 'cancelled'

export class ResponseState {
  readonly id = newId('resp')
  readonly createdAt = Math.floor(Date.now() / 1000)
  status: Status = 'in_progress'
  output: Json[] = []
  usage: UsageTotals | null = null
  error: { code: string; message: string } | null = null
  incomplete: { reason: string } | null = null
  /** How the gateway reached Claude Code for this response (live process, store or history rebuild). */
  gateway: Json = {}

  constructor(readonly req: NormRequest) {}

  object(): Json {
    const b = this.req.body
    return {
      id: this.id,
      object: 'response',
      created_at: this.createdAt,
      status: this.status,
      background: false,
      error: this.error,
      incomplete_details: this.incomplete,
      instructions: this.req.instructions,
      max_output_tokens: this.req.maxOutputTokens,
      model: this.req.model,
      output: this.output,
      parallel_tool_calls: true,
      previous_response_id: this.req.previousResponseId,
      reasoning: { effort: b.reasoning?.effort ?? null, summary: null },
      store: true,
      temperature: null,
      text: { format: { type: 'text' } },
      tool_choice: 'auto',
      tools: this.req.tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters, strict: false })),
      top_p: null,
      truncation: 'disabled',
      usage: this.usage ? usageObject(this.usage) : null,
      user: b.user ?? null,
      metadata: this.req.metadata,
      x_gateway: this.gateway,
    }
  }
}

export interface SinkEvent {
  type: string
  data: Json
}

/** The lane emits the same ordered events regardless of transport. Cancellation is synchronous and idempotent. */
export interface EventSink {
  readonly isClosed: boolean
  onCancel: (() => void) | null
  send(type: string, data: Json): void
  /** Serialize/check the entire terminal batch before the store changes. The returned synchronous enqueue
   * reports transport acceptance, not peer consumption. No asynchronous work may separate prepare/enqueue. */
  prepare(events: SinkEvent[]): (() => boolean) | null
  close(): void
  /** Refuses the response as a whole, before any of it was sent (see GatedSink); false once it is open. */
  refuse?(err: GatewayError): boolean
  /** Sends an event outside the response's sequence (`codex.rate_limits`), even after the response ended, for as long
   * as the transport lives. Only the WebSocket has one. */
  metadata?(event: Json): void
}

/** Writes SSE events to a ReadableStream the HTTP layer returns. */
export class SseSink implements EventSink {
  readonly stream: ReadableStream<Uint8Array>
  private ctrl!: ReadableStreamDefaultController<Uint8Array>
  private seq = 0
  private closed = false
  onCancel: (() => void) | null = null
  readonly events: Json[] = []

  constructor() {
    this.stream = new ReadableStream<Uint8Array>({
      start: (c) => {
        this.ctrl = c
      },
      cancel: () => {
        this.closed = true
        this.onCancel?.()
      },
    })
  }

  get isClosed(): boolean {
    return this.closed
  }

  send(type: string, data: Json): void {
    this.prepare([{ type, data }])?.()
  }

  prepare(events: SinkEvent[]): (() => boolean) | null {
    if (this.closed) return null
    const seq = this.seq
    const bytes = new TextEncoder().encode(
      events.map(({ type, data }, i) => {
        const event = { type, sequence_number: seq + i, ...data }
        return `event: ${type}\ndata: ${JSON.stringify(event)}\n\n`
      }).join(''),
    )
    return () => {
      if (this.closed) return false
      try {
        // One enqueue for the whole batch: a cancel before it refuses every terminal emission.
        this.ctrl.enqueue(bytes)
        this.seq += events.length
        return true
      } catch {
        this.closed = true
        return false
      }
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    try {
      this.ctrl.close()
    } catch { /* already closed */ }
  }
}

/** The events a gated sink holds; any other is output (or the end), and opens it. */
const OPENING = new Set(['response.created', 'response.in_progress'])

export interface GateHooks {
  /** The held events went out: the response is streaming. */
  opened?(): void
  /** The response was refused before any of it went out; the gate is closed. */
  refused(err: GatewayError): void
}

/**
 * Holds a response's opening events (`response.created`, `response.in_progress`) until its first client-visible
 * output, so a response the backend refuses before any (a 429) can be refused as a request: a real HTTP 429 with
 * `Retry-After`, or the WebSocket `error` event. A model message holding only calls Claude Code answers natively sends
 * nothing, so it does not open the gate. Held events are checked against the transport as they come, exactly as if
 * they had been sent; the first output or terminal event sends them with it, in one batch.
 */
export class GatedSink implements EventSink {
  onCancel: (() => void) | null = null
  /** Null once open. */
  private held: SinkEvent[] | null = []
  private refusedWith: GatewayError | null = null

  constructor(private readonly inner: EventSink, private readonly hooks: GateHooks) {
    inner.onCancel = () => this.onCancel?.()
  }

  get isClosed(): boolean {
    return this.refusedWith !== null || this.inner.isClosed
  }

  get isOpen(): boolean {
    return this.held === null
  }

  send(type: string, data: Json): void {
    this.prepare([{ type, data }])?.()
  }

  prepare(events: SinkEvent[]): (() => boolean) | null {
    if (this.isClosed) return null
    if (this.held === null) return this.inner.prepare(events)
    const send = this.inner.prepare([...this.held, ...events])
    if (!send) return null
    if (events.every((e) => OPENING.has(e.type))) {
      return () => {
        if (this.isClosed || this.held === null) return false
        this.held.push(...events)
        return true
      }
    }
    return () => {
      if (this.isClosed || this.held === null || !send()) return false
      this.release()
      return true
    }
  }

  private open(): void {
    if (this.isClosed || this.held === null) return
    // a refused send means the transport is gone, and its cancel reaches the lane
    if (this.inner.prepare(this.held)?.()) this.release()
  }

  refuse(err: GatewayError): boolean {
    if (this.isClosed || this.held === null) return false
    this.refusedWith = err
    this.held = null
    this.hooks.refused(err)
    return true
  }

  close(): void {
    // a response the lane ends without a terminal event (a cancelled emission) still sends what it held
    this.open()
    this.inner.close()
  }

  metadata(event: Json): void {
    this.inner.metadata?.(event)
  }

  private release(): void {
    this.held = null
    this.hooks.opened?.()
  }
}

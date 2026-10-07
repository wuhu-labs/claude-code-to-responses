// The response object and its server-sent events, in OpenAI's Responses streaming shape.
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
      max_output_tokens: null,
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

/** The lane emits the same ordered events regardless of transport. Cancellation is synchronous and idempotent. */
export interface EventSink {
  readonly isClosed: boolean
  onCancel: (() => void) | null
  send(type: string, data: Json): void
  close(): void
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
    if (this.closed) return
    const ev = { type, sequence_number: this.seq++, ...data }
    try {
      this.ctrl.enqueue(new TextEncoder().encode(`event: ${type}\ndata: ${JSON.stringify(ev)}\n\n`))
    } catch {
      this.closed = true
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

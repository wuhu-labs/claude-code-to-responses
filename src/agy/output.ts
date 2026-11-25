import type { InItem, NormRequest } from '../api/request.ts'
import { type EventSink, newId, ResponseState } from '../api/stream.ts'
import { serverError } from '../errors.ts'
import type { Tokens } from './transcript.ts'

export type Call = { callId: string; name: string; args: Record<string, unknown> }

type Segment = { type: 'text' | 'thought'; index: number; id: string; text: string }

/** A response streams ACP chunks, then uses the matching planner line to finalize their contents. */
export class Output extends ResponseState {
  tokens: Tokens | null = null
  private parts = new Map<Segment['type'], Segment>()

  constructor(req: NormRequest, readonly sink: EventSink) {
    super(req)
  }

  override object() {
    const u = this.tokens
    const input = u ? u.input_tokens + u.cached_read_tokens + u.cached_write_tokens : 0
    return {
      ...super.object(),
      max_output_tokens: null,
      reasoning: { effort: null, summary: null },
      usage: u
        ? {
          input_tokens: input,
          input_tokens_details: { cached_tokens: u.cached_read_tokens },
          output_tokens: u.output_tokens,
          output_tokens_details: { reasoning_tokens: u.thought_tokens ?? 0 },
          total_tokens: input + u.output_tokens,
        }
        : null,
    }
  }

  open() {
    const response = { ...this.object(), output: [] }
    this.send('response.created', { response })
    this.send('response.in_progress', { response })
  }

  private send(type: string, data: unknown) {
    if (!this.sink.prepare([{ type, data }])?.()) throw serverError('server_error', 'The Responses stream is closed.')
  }

  chunk(type: Segment['type'], delta: string) {
    if (!delta) return
    let part = this.parts.get(type)
    if (!part) {
      const id = newId(type === 'text' ? 'msg' : 'rs'), index = this.output.length
      const item = type === 'text'
        ? { type: 'message', id, role: 'assistant', content: [], status: 'in_progress' }
        : { type: 'reasoning', id, summary: [], content: [] }
      this.output.push(item)
      this.send('response.output_item.added', { output_index: index, item })
      if (type === 'text') this.send('response.content_part.added', { item_id: id, output_index: index, content_index: 0, part: textPart('') })
      part = { type, id, index, text: '' }
      this.parts.set(type, part)
    }
    part.text += delta
    const location = { item_id: part.id, output_index: part.index, content_index: 0 }
    if (type === 'text') this.send('response.output_text.delta', { ...location, delta, logprobs: [] })
    else this.send('response.reasoning_text.delta', { ...location, delta })
  }

  finalize(calls: Call[], planner?: { text: string; thinking: string }): InItem[] {
    for (const [type, text] of [['text', planner?.text], ['thought', planner?.thinking]] as const) {
      if (text === undefined) continue
      const streamed = this.parts.get(type)?.text ?? ''
      if (text.startsWith(streamed)) this.chunk(type, text.slice(streamed.length))
    }
    const history: InItem[] = []
    for (const { type, index, id, text: streamed } of this.parts.values()) {
      const text = (type === 'text' ? planner?.text : planner?.thinking) || streamed
      const where = { item_id: id, output_index: index, content_index: 0 }
      if (type === 'text') {
        const part = textPart(text)
        this.send('response.output_text.done', { ...where, text, logprobs: [] })
        this.send('response.content_part.done', { ...where, part })
        this.output[index] = { type: 'message', role: 'assistant', id, content: [part], status: 'completed' }
        history.push({ kind: 'message', role: 'assistant', parts: [{ type: 'text', text }] })
      } else {
        this.send('response.reasoning_text.done', { ...where, text })
        this.output[index] = { type: 'reasoning', id, summary: [], content: [{ type: 'reasoning_text', text }] }
      }
      this.send('response.output_item.done', { output_index: index, item: this.output[index] })
    }
    for (const { callId, name, args } of calls) {
      const id = newId('fc'), output_index = this.output.length, arguments_ = JSON.stringify(args)
      const item = { type: 'function_call', id, call_id: callId, name, arguments: '', status: 'in_progress' }
      this.send('response.output_item.added', { output_index, item })
      this.send('response.function_call_arguments.delta', { item_id: id, output_index, delta: arguments_ })
      this.send('response.function_call_arguments.done', { item_id: id, output_index, name, arguments: arguments_ })
      const done = { ...item, arguments: arguments_, status: 'completed' }
      this.output.push(done)
      this.send('response.output_item.done', { output_index, item: done })
      history.push({ kind: 'function_call', callId, name, arguments: arguments_ })
    }
    return history
  }
}

const textPart = (text: string) => ({ type: 'output_text', text, annotations: [], logprobs: [] })

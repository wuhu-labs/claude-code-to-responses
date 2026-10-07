import type { Json } from './fake.ts'

// Project exactly as ResponsesRequestBuilder + ResponsesWebSocketSession at monorepo def9ef929.
// Basic prompt/user literals come from buildsBasicResponsesRequest; tool/history layouts come from its sibling tests.
const committedIDs = new Map<string, string>()
export function committedCallId(provider: string): string {
  if (!committedIDs.has(provider)) committedIDs.set(provider, crypto.randomUUID())
  return committedIDs.get(provider)!
}

export function kernelBody(body: Json): Json {
  const { instructions, ...rest } = body
  let messageIndex = 0
  const input = body.input.map((it: Json) => {
    if (it.role === 'user') return { role: 'user', content: typeof it.content === 'string' ? [{ type: 'input_text', text: it.content }] : it.content }
    if (it.role === 'assistant') {
      return {
        type: 'message',
        role: 'assistant',
        content: it.content.map((p: Json) => ({ type: 'output_text', text: p.text, annotations: [] })),
        status: 'completed',
        id: `msg_${messageIndex++}`,
        ...(it.phase ? { phase: it.phase } : {}),
      }
    }
    if (it.type === 'reasoning') return { type: 'reasoning', ...(it.id ? { id: it.id } : {}), summary: [], encrypted_content: it.encrypted_content }
    if (it.type === 'function_call') return { type: 'function_call', call_id: committedCallId(it.call_id), name: it.name, arguments: it.arguments }
    if (it.type === 'function_call_output' && !body.previous_response_id) return { ...it, call_id: committedCallId(it.call_id) }
    return it
  })
  return {
    ...rest,
    input: body.previous_response_id ? input : [{ role: 'system', content: instructions }, ...input],
    store: false,
    max_output_tokens: 4096,
    reasoning: { effort: body.reasoning?.effort ?? 'high', summary: 'auto' },
    include: ['reasoning.encrypted_content'],
    prompt_cache_key: 'kernel-test-session',
    tools: (body.tools ?? []).map((t: Json) => ({ ...t, strict: false })),
  }
}

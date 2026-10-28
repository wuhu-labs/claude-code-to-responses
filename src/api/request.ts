// Validation of POST /v1/responses bodies against the supported subset. Anything outside it is a typed 400.
import { invalid, unsupported } from '../errors.ts'
import { DEFAULT_EFFORT, EFFORTS, MAX_TOOL_NAME } from '../claude/pins.ts'

// deno-lint-ignore no-explicit-any
type Json = any

/** Gateway-owned per-image input cap, enforced before Claude Code can resize or re-encode the image. */

export type Part = { type: 'text'; text: string } | { type: 'image'; mediaType: string; data: string }

export type InItem =
  | { kind: 'message'; role: 'user' | 'assistant'; parts: Part[] }
  | { kind: 'function_call'; callId: string; name: string; arguments: string }
  | { kind: 'function_call_output'; callId: string; parts: Part[] }
  | { kind: 'reasoning'; encrypted: string | null }

export interface FnTool {
  name: string
  description: string
  parameters: Json
}

export interface NormRequest {
  model: string
  instructions: string | null
  maxOutputTokens: number | null
  tools: FnTool[]
  effort: string
  previousResponseId: string | null
  input: InItem[]
  metadata: Record<string, string>
  /** Only response echo fields; never retain the original input body. */
  body: Json
}

const ACCEPTED = new Set([
  'model',
  'input',
  'instructions',
  'tools',
  'tool_choice',
  'parallel_tool_calls',
  'stream',
  'store',
  'previous_response_id',
  'reasoning',
  'include',
  'metadata',
  'text',
  'truncation',
  'user',
  'prompt_cache_key',
  'safety_identifier',
  'service_tier',
  'background',
  'max_output_tokens',
  'temperature',
  'top_p',
  'stream_options',
])

const isObj = (v: unknown): v is Record<string, Json> => typeof v === 'object' && v !== null && !Array.isArray(v)

export function parseRequest(body: unknown, transport: 'sse' | 'websocket' = 'sse'): NormRequest {
  if (!isObj(body)) throw invalid(null, 'The request body must be a JSON object.')
  for (const k of Object.keys(body)) {
    if (!ACCEPTED.has(k)) throw unsupported(k, `Field '${k}' is not supported by this gateway.`)
  }
  if (transport === 'websocket') {
    if ('stream' in body) throw unsupported('stream', "WebSocket responses stream implicitly: omit 'stream'.")
  } else if (body.stream !== true) throw unsupported('stream', "Only streaming responses are supported: set 'stream' to true.")
  if (body.background !== undefined && body.background !== false && body.background !== null) {
    throw unsupported('background', 'Background mode is not supported.')
  }
  // `store` is a client compatibility field, not a retention switch. Durable gateway records always
  // survive transport changes/reconnects, regardless of the accepted boolean (or its absence).
  if (body.store !== undefined && typeof body.store !== 'boolean') {
    throw invalid('store', "'store' must be a boolean when present; it does not change gateway retention.")
  }
  for (const k of ['temperature', 'top_p']) {
    if (body[k] !== undefined && body[k] !== null) throw unsupported(k, `'${k}' is not supported: Claude Code sets it.`)
  }
  const maxOutputTokens = body.max_output_tokens ?? null
  if (maxOutputTokens !== null && (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens <= 0)) {
    throw invalid('max_output_tokens', "'max_output_tokens' must be a positive safe integer.")
  }
  if (body.tool_choice !== undefined && body.tool_choice !== null && body.tool_choice !== 'auto') {
    const t = body.tool_choice
    if (!isObj(t) || t.type !== 'function' || typeof t.name !== 'string' || !t.name || Object.keys(t).some((k) => k !== 'type' && k !== 'name')) {
      throw unsupported('tool_choice', "Only 'auto' or a named function choice is supported; named choices are accepted but not forced.")
    }
  }
  if (body.parallel_tool_calls !== undefined && body.parallel_tool_calls !== null && body.parallel_tool_calls !== true) {
    throw unsupported('parallel_tool_calls', "'parallel_tool_calls: false' is not supported.")
  }
  if (body.truncation !== undefined && body.truncation !== null && body.truncation !== 'disabled') {
    throw unsupported('truncation', "Only 'truncation: disabled' is supported.")
  }
  if (body.service_tier !== undefined && body.service_tier !== null && body.service_tier !== 'auto' && body.service_tier !== 'default') {
    throw unsupported('service_tier', "Only 'service_tier: auto' is supported.")
  }
  if (body.stream_options !== undefined && body.stream_options !== null) {
    if (!isObj(body.stream_options) || Object.keys(body.stream_options).some((k) => k !== 'include_obfuscation')) {
      throw unsupported('stream_options', 'Only stream_options.include_obfuscation is accepted.')
    }
  }
  if (body.text !== undefined && body.text !== null) {
    const f = isObj(body.text) ? body.text.format : undefined
    const keys = isObj(body.text) ? Object.keys(body.text) : []
    if (!isObj(body.text) || keys.some((k) => k !== 'format' && k !== 'verbosity') || (f !== undefined && (!isObj(f) || f.type !== 'text'))) {
      throw unsupported('text', "Only plain text output ('text.format.type: text') is supported.")
    }
    if (body.text.verbosity !== undefined && body.text.verbosity !== null && body.text.verbosity !== 'medium') {
      throw unsupported('text.verbosity', "Only 'text.verbosity: medium' is supported.")
    }
  }
  if (body.include !== undefined && body.include !== null) {
    if (!Array.isArray(body.include) || body.include.some((x: unknown) => x !== 'reasoning.encrypted_content')) {
      throw unsupported('include', "Only 'reasoning.encrypted_content' can be included (it always is).")
    }
  }
  for (const k of ['user', 'prompt_cache_key', 'safety_identifier']) {
    if (body[k] !== undefined && body[k] !== null && typeof body[k] !== 'string') throw invalid(k, `'${k}' must be a string.`)
  }

  if (typeof body.model !== 'string' || !body.model) throw invalid('model', "'model' is required.")

  let effort = DEFAULT_EFFORT
  if (body.reasoning !== undefined && body.reasoning !== null) {
    if (!isObj(body.reasoning)) throw invalid('reasoning', "'reasoning' must be an object.")
    for (const k of Object.keys(body.reasoning)) {
      if (k === 'effort') continue
      if (k === 'summary' && body.reasoning[k] === 'auto') continue
      if ((k === 'summary' || k === 'generate_summary') && (body.reasoning[k] === null || body.reasoning[k] === undefined)) continue
      throw unsupported(`reasoning.${k}`, `'reasoning.${k}' is not supported: thinking is returned as reasoning text, never summarized.`)
    }
    const e = body.reasoning.effort
    if (e !== undefined && e !== null) {
      if (typeof e !== 'string' || !(e in EFFORTS)) {
        throw unsupported('reasoning.effort', `Effort '${e}' is not supported; use one of ${Object.keys(EFFORTS).join(', ')}.`)
      }
      effort = EFFORTS[e]
    }
  }

  const tools: FnTool[] = []
  if (body.tools !== undefined && body.tools !== null) {
    if (!Array.isArray(body.tools)) throw invalid('tools', "'tools' must be an array.")
    const names = new Set<string>()
    body.tools.forEach((t: Json, i: number) => {
      const p = `tools[${i}]`
      if (!isObj(t) || t.type !== 'function') throw unsupported(`${p}.type`, 'Only function tools are supported.')
      for (const k of Object.keys(t)) {
        if (!['type', 'name', 'description', 'parameters', 'strict'].includes(k)) throw unsupported(`${p}.${k}`, `Tool field '${k}' is not supported.`)
      }
      if (t.strict === true) throw unsupported(`${p}.strict`, "'strict: true' is not supported: Claude Code does not enforce schemas.")
      if (typeof t.name !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(t.name) || t.name.length > MAX_TOOL_NAME) {
        throw invalid(`${p}.name`, `Tool names must match ^[a-zA-Z0-9_-]+$ and be at most ${MAX_TOOL_NAME} characters.`)
      }
      if (names.has(t.name)) throw invalid(`${p}.name`, `Duplicate tool name '${t.name}'.`)
      names.add(t.name)
      if (t.description !== undefined && t.description !== null && typeof t.description !== 'string') {
        throw invalid(`${p}.description`, 'Tool descriptions must be strings.')
      }
      const parameters = t.parameters ?? { type: 'object', properties: {} }
      if (!isObj(parameters) || parameters.type !== 'object') throw invalid(`${p}.parameters`, "Tool parameters must be a JSON Schema with 'type: object'.")
      tools.push({ name: t.name, description: t.description ?? '', parameters })
    })
  }

  let previousResponseId: string | null = null
  if (body.previous_response_id !== undefined && body.previous_response_id !== null) {
    if (typeof body.previous_response_id !== 'string' || !body.previous_response_id) {
      throw invalid('previous_response_id', "'previous_response_id' must be a string.")
    }
    previousResponseId = body.previous_response_id
  }

  const metadata: Record<string, string> = {}
  if (body.metadata !== undefined && body.metadata !== null) {
    if (!isObj(body.metadata)) throw invalid('metadata', "'metadata' must be an object of strings.")
    for (const [k, v] of Object.entries(body.metadata)) {
      if (typeof v !== 'string') throw invalid(`metadata.${k}`, 'Metadata values must be strings.')
      metadata[k] = v
    }
  }

  if (isObj(body.tool_choice) && !tools.some((t) => t.name === body.tool_choice.name)) {
    throw invalid('tool_choice.name', 'A named tool choice must name one of the request’s function tools.')
  }
  const { instructions, input } = parseInstructionsAndInput(body, previousResponseId)
  if (input.length === 0) throw invalid('input', "'input' must not be empty.")
  return {
    model: body.model,
    instructions,
    maxOutputTokens,
    tools,
    effort,
    previousResponseId,
    input,
    metadata,
    body: { reasoning: { effort: body.reasoning?.effort }, user: body.user },
  }
}

function parseInstructionsAndInput(body: Json, previous: string | null): { instructions: string | null; input: InItem[] } {
  const input = body.input
  const leading: string[] = []
  let first = 0
  if (Array.isArray(input)) {
    while (first < input.length) {
      const it = input[first]
      if (!isObj(it) || (it.type !== undefined && it.type !== 'message') || (it.role !== 'system' && it.role !== 'developer')) break
      const p = `input[${first}]`
      if (previous !== null) throw unsupported(`${p}.role`, 'System/developer input messages are only accepted at the beginning of a full create.')
      if ('instructions' in body) throw invalid('instructions', 'Use top-level instructions or leading system/developer messages, never both.')
      if (typeof it.content === 'string') leading.push(it.content)
      else if (Array.isArray(it.content)) {
        for (let j = 0; j < it.content.length; j++) {
          const part = it.content[j]
          if (!isObj(part) || part.type !== 'input_text') throw unsupported(`${p}.content[${j}].type`, 'Instructions accept only input_text parts.')
          if (typeof part.text !== 'string') throw invalid(`${p}.content[${j}].text`, 'Instruction text must be a string.')
          leading.push(part.text)
        }
      } else throw invalid(`${p}.content`, 'Instructions must be a string or an array of input_text parts.')
      first++
    }
  }
  let instructions: string | null = null
  if ('instructions' in body) {
    if (typeof body.instructions !== 'string' || !body.instructions) throw invalid('instructions', "'instructions' must be a nonempty string.")
    instructions = body.instructions
  } else if (first > 0) instructions = leading.join('')
  let items: InItem[]
  if (typeof input === 'string') items = [{ kind: 'message', role: 'user', parts: [{ type: 'text', text: input }] }]
  else if (Array.isArray(input)) items = input.slice(first).map((it, i) => parseItem(it, `input[${i + first}]`))
  else throw invalid('input', "'input' must be a string or an array of items.")
  if (previous === null && !instructions) {
    throw invalid('instructions', 'The kernel must carry a nonempty session prompt in top-level instructions or leading system/developer text.')
  }
  return { instructions, input: items }
}

function parseItem(it: unknown, p: string): InItem {
  if (!isObj(it)) throw invalid(p, 'Input items must be objects.')
  const type = it.type ?? (it.role !== undefined ? 'message' : undefined)
  switch (type) {
    case 'message': {
      const role = it.role
      if (role !== 'user' && role !== 'assistant') {
        throw unsupported(`${p}.role`, `Message role '${role}' is not supported here: system/developer messages must lead a full create.`)
      }
      return { kind: 'message', role, parts: parseContent(it.content, `${p}.content`, role) }
    }
    case 'function_call': {
      if (typeof it.call_id !== 'string' || !it.call_id) throw invalid(`${p}.call_id`, 'function_call items need a call_id.')
      if (typeof it.name !== 'string' || !it.name) throw invalid(`${p}.name`, 'function_call items need a name.')
      if (typeof it.arguments !== 'string') throw invalid(`${p}.arguments`, 'function_call arguments must be a JSON string.')
      let args: unknown
      try {
        args = JSON.parse(it.arguments)
      } catch {
        args = undefined
      }
      if (typeof args !== 'object' || args === null || Array.isArray(args)) {
        throw invalid(`${p}.arguments`, 'function_call arguments must be a JSON object, as the model produced them.', 'invalid_function_arguments')
      }
      return { kind: 'function_call', callId: it.call_id, name: it.name, arguments: it.arguments }
    }
    case 'function_call_output': {
      if (typeof it.call_id !== 'string' || !it.call_id) throw invalid(`${p}.call_id`, 'function_call_output items need a call_id.')
      const out = it.output
      const parts = typeof out === 'string' ? [{ type: 'text', text: out } as Part] : parseContent(out, `${p}.output`, 'user')
      return { kind: 'function_call_output', callId: it.call_id, parts }
    }
    case 'reasoning': {
      const enc = it.encrypted_content
      if (enc !== undefined && enc !== null && typeof enc !== 'string') throw invalid(`${p}.encrypted_content`, 'encrypted_content must be a string.')
      return { kind: 'reasoning', encrypted: enc ?? null }
    }
    default:
      throw unsupported(`${p}.type`, `Input item type '${type}' is not supported.`)
  }
}

function parseContent(content: unknown, p: string, role: 'user' | 'assistant'): Part[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  if (!Array.isArray(content)) throw invalid(p, 'Content must be a string or an array of parts.')
  return content.map((c, i) => {
    const q = `${p}[${i}]`
    if (!isObj(c)) throw invalid(q, 'Content parts must be objects.')
    if (c.type === 'input_text' || c.type === 'output_text') {
      if (typeof c.text !== 'string') throw invalid(`${q}.text`, 'Text parts need a string text.')
      if (c.type === 'output_text' && role !== 'assistant') throw invalid(`${q}.type`, "'output_text' belongs to assistant messages.")
      if (c.type === 'output_text' && Array.isArray(c.annotations) && c.annotations.length) {
        throw unsupported(`${q}.annotations`, 'Annotations are not supported.')
      }
      return { type: 'text', text: c.text }
    }
    if (c.type === 'input_image' && role === 'user') {
      const url = c.image_url
      const m = typeof url === 'string' ? /^data:(image\/(?:png|jpeg|gif|webp));base64,([\s\S]*)$/.exec(url) : null
      if (!m) throw unsupported(`${q}.image_url`, 'Only base64 data URLs of png, jpeg, gif or webp images are supported.')
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(m[2])) throw invalid(`${q}.image_url`, 'Image data must be valid nonempty base64.')
      try {
        atob(m[2])
      } catch {
        throw invalid(`${q}.image_url`, 'Image data must be valid base64.')
      }
      return { type: 'image', mediaType: m[1], data: m[2] }
    }
    throw unsupported(`${q}.type`, `Content part type '${c.type}' is not supported here.`)
  })
}

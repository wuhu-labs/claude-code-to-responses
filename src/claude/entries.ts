// Log entries the gateway writes itself: the tool results and user text of the interrupted-turn resume, and
// synthesized history for items that came without provider records (a cold cache by design).
import type { InItem, Part } from '../api/request.ts'
import { decodeThinking } from '../records.ts'
import { CLAUDE_CODE_VERSION, MCP_PREFIX } from './pins.ts'

// deno-lint-ignore no-explicit-any
type Json = any

export interface LogContext {
  sessionId: string
  cwd: string
  /** uuid of the last chain entry so far; null for an empty log. */
  parent: string | null
  promptId: string | null
  gitBranch: string | undefined
}

/** Reads the context to append entries after an existing log. */
export function contextOf(lines: string[], sessionId: string, cwd: string): LogContext {
  const ctx: LogContext = { sessionId, cwd, parent: null, promptId: null, gitBranch: undefined }
  for (const l of lines) {
    let e: Json
    try {
      e = JSON.parse(l)
    } catch {
      continue
    }
    if (typeof e.uuid === 'string' && e.isSidechain === false) ctx.parent = e.uuid
    if (e.type === 'user' && typeof e.promptId === 'string') ctx.promptId = e.promptId
    if (typeof e.gitBranch === 'string') ctx.gitBranch = e.gitBranch
    if (typeof e.cwd === 'string') ctx.cwd = e.cwd
  }
  return ctx
}

function base(ctx: LogContext, fields: Json): Json {
  const e = {
    parentUuid: ctx.parent,
    isSidechain: false,
    ...fields,
    uuid: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    userType: 'external',
    entrypoint: 'sdk-cli',
    cwd: ctx.cwd,
    sessionId: ctx.sessionId,
    version: CLAUDE_CODE_VERSION,
    ...(ctx.gitBranch !== undefined ? { gitBranch: ctx.gitBranch } : {}),
  }
  ctx.parent = e.uuid
  return e
}

export function contentBlocks(parts: Part[]): Json[] {
  return parts.map((p) =>
    p.type === 'text' ? { type: 'text', text: p.text } : { type: 'image', source: { type: 'base64', media_type: p.mediaType, data: p.data } }
  )
}

/** A tool result as Claude Code logs an MCP result (text and image content). */
export function toolResultEntry(ctx: LogContext, callId: string, parts: Part[], assistantUuid: string | null): Json {
  const content = contentBlocks(parts)
  return base(ctx, {
    ...(ctx.promptId ? { promptId: ctx.promptId } : {}),
    type: 'user',
    message: { role: 'user', content: [{ tool_use_id: callId, type: 'tool_result', content }] },
    toolUseResult: content,
    ...(assistantUuid ? { sourceToolAssistantUUID: assistantUuid } : {}),
  })
}

/**
 * Claude Code's own answer to a call of a tool it doesn't have, as 2.1.284 logs it the moment the call streams in.
 * The client's output for such a call never reaches the model, on the live path or after a rebuild.
 */
export function unknownToolEntry(ctx: LogContext, callId: string, mcpName: string, assistantUuid: string | null): Json {
  const error = `Error: No such tool available: ${mcpName}`
  return base(ctx, {
    ...(ctx.promptId ? { promptId: ctx.promptId } : {}),
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', content: `<tool_use_error>${error}</tool_use_error>`, is_error: true, tool_use_id: callId }] },
    toolUseResult: error,
    ...(assistantUuid ? { sourceToolAssistantUUID: assistantUuid } : {}),
  })
}

/** Whether the log already answers a tool call (Claude Code answers calls of unknown tools by itself). */
export function hasToolResult(lines: string[], callId: string): boolean {
  return lines.some((l) => l.includes(callId) && l.includes('"tool_result"') && l.includes(`"tool_use_id":"${callId}"`))
}

/** A plain (non-meta) user text entry: what the interrupted-turn resume sends after the tool results. */
export function userTextEntry(ctx: LogContext, text: string): Json {
  return base(ctx, {
    ...(ctx.promptId ? { promptId: ctx.promptId } : {}),
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
  })
}

export function userMessageEntry(ctx: LogContext, parts: Part[]): Json {
  ctx.promptId = crypto.randomUUID()
  return base(ctx, { promptId: ctx.promptId, type: 'user', message: { role: 'user', content: contentBlocks(parts) }, promptSource: 'sdk' })
}

/** uuid of the assistant entry holding a tool_use block, for sourceToolAssistantUUID. */
export function assistantUuidFor(lines: string[], callId: string): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    let e: Json
    try {
      e = JSON.parse(lines[i])
    } catch {
      continue
    }
    if (e.type === 'assistant' && Array.isArray(e.message?.content) && e.message.content.some((b: Json) => b.type === 'tool_use' && b.id === callId)) {
      return e.uuid
    }
  }
  return null
}

let synthCounter = 0

/** Assistant entries for one response's output items: one entry per block, as Claude Code logs them. */
export function assistantEntries(ctx: LogContext, outputs: InItem[], model: string): { entries: Json[]; calls: { id: string; name: string }[] } {
  const blocks: Json[] = []
  const calls: { id: string; name: string }[] = []
  for (const it of outputs) {
    if (it.kind === 'reasoning') {
      const t = it.encrypted ? decodeThinking(it.encrypted) : null
      if (t?.redacted) blocks.push({ type: 'redacted_thinking', data: t.redacted })
      else if (t?.signature !== undefined && t.thinking !== undefined) blocks.push({ type: 'thinking', thinking: t.thinking, signature: t.signature })
      // reasoning without a signature cannot be replayed to the model, and provider records are not content
    } else if (it.kind === 'message') {
      for (const p of it.parts) if (p.type === 'text') blocks.push({ type: 'text', text: p.text })
    } else if (it.kind === 'function_call') {
      // parseRequest already refused arguments that are not a JSON object
      const input: Json = JSON.parse(it.arguments)
      blocks.push({ type: 'tool_use', id: it.callId, name: MCP_PREFIX + it.name, input })
      calls.push({ id: it.callId, name: it.name })
    }
  }
  if (blocks.length === 0) blocks.push({ type: 'text', text: '' })
  const id = `msg_synth_${Date.now().toString(36)}_${(synthCounter++).toString(36)}`
  const stop = calls.length ? 'tool_use' : 'end_turn'
  const entries = blocks.map((b, k) =>
    base(ctx, {
      message: {
        id,
        type: 'message',
        role: 'assistant',
        model,
        content: [b],
        stop_reason: stop,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
      apiBlockIndex: k,
      type: 'assistant',
    })
  )
  return { entries, calls }
}

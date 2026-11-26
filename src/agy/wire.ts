// The pinned ACP/MCP subset. Do not infer permissions from ACP titles (they may be shell text).
import type { Part } from '../api/request.ts'

export const MCP_NAME = 'responses'
export const MCP_PREFIX = `mcp_${MCP_NAME}_`
export const BRIDGE_PATH = '/_agy'
export const CONVERSATION_KEY = 'antigravity.google/conversation_id'
export const AGY_ENV = { AGY_CLI_DISABLE_AUTO_UPDATE: 'true' }

export type JsonObject = Record<string, unknown>
export function object(v: unknown): JsonObject | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? v as JsonObject : undefined
}
export const string = (v: unknown): string | undefined => typeof v === 'string' ? v : undefined
export const count = (v: unknown): number | undefined => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined
export const safeId = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(v)

export type RpcId = string | number
export function rpcId(v: unknown): RpcId | undefined {
  return typeof v === 'string' || typeof v === 'number' ? v : undefined
}
export const rpc = (id: RpcId, result: unknown) => ({ jsonrpc: '2.0', id, result })
export const rpcError = (id: RpcId, code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } })

export type AcpCall = { id: string; name: string; args: JsonObject }
export type ToolSignature = { name: string; args: JsonObject }
export type HookStep = { userMessage: string } | { systemMessage: { systemMessage: string } }
/** One MCP result item, the shape agy accepts from a tool. Images are passed through byte for byte. */
export type ToolContent = { type: 'text'; text: string } | { type: 'image'; mimeType: string; data: string }
export type ToolResult = { content: ToolContent[]; isError: boolean }

export function toolResult(text: string, isError = false): ToolResult {
  return { content: [{ type: 'text', text }], isError }
}

/** The client's tool output as agy's MCP result: agy offloads each image to a file and names it in the output text. */
export function toolResultOf(parts: Part[]): ToolResult {
  return {
    content: parts.map((part) => part.type === 'text' ? { type: 'text', text: part.text } : { type: 'image', mimeType: part.mediaType, data: part.data }),
    isError: false,
  }
}

export function toolArgs(args: JsonObject): JsonObject {
  const { toolSummary: _, ...rest } = args
  return rest
}

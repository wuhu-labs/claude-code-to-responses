// Provider records: the Claude Code log entries behind each response, carried opaquely in a reasoning item's
// encrypted_content and kept in the response store. log(r) = log(r.prev) + r.entries, byte for byte.
import type { InItem, Part } from './api/request.ts'

export const RECORD_PREFIX = 'cc2r.record.v1.'
export const THINKING_PREFIX = 'cc2r.thinking.v1.'

export interface CallRef {
  /** Claude Code's tool_use id, which is also the function_call's call_id. */
  id: string
  /** The client's tool name (without the MCP prefix). */
  name: string
}

export interface ProviderRecord {
  v: 1
  /** Response id. */
  id: string
  /** The response whose log this one continues; null when it starts the log. */
  prev: string | null
  /** Chain key: instructions, tools, model and effort. */
  chain: string
  /** Claude Code session id. */
  session: string
  /** How the response ended: a finished turn, or tool calls Claude Code waits on. */
  end: 'turn' | 'calls'
  calls: CallRef[]
  /** Digest of every item this record covers: the inputs since `prev` (any synthesized history too) and the outputs. */
  digest: string
  /** Log lines Claude Code (or the gateway, for rebuilt history and the interrupted-turn resume) wrote since `prev`, verbatim. */
  entries: string[]
}

export interface ThinkingRecord {
  thinking?: string
  signature?: string
  redacted?: string
}

async function gzip(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const s = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))
  return new Uint8Array(await new Response(s).arrayBuffer())
}
async function gunzip(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const s = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))
  return new Uint8Array(await new Response(s).arrayBuffer())
}
function b64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}
function unb64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export async function encodeRecord(r: ProviderRecord): Promise<string> {
  return RECORD_PREFIX + b64(await gzip(new TextEncoder().encode(JSON.stringify(r))))
}

export class RecordError extends Error {}

export const RESPONSE_ID = /^resp_[0-9a-f]{32}$/
export const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const HEX64 = /^[0-9a-f]{64}$/
const CALL_ID = /^[A-Za-z0-9_-]{1,128}$/
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/

/**
 * Decodes a record: null when the string is not one of ours. A string with our prefix that is not a well-formed
 * record throws RecordError: its fields reach file paths and Claude Code's log, so nothing unchecked gets through.
 */
export async function decodeRecord(s: string): Promise<ProviderRecord | null> {
  if (!s.startsWith(RECORD_PREFIX)) return null
  // deno-lint-ignore no-explicit-any
  let r: any
  try {
    r = JSON.parse(new TextDecoder().decode(await gunzip(unb64(s.slice(RECORD_PREFIX.length)))))
  } catch {
    throw new RecordError('not valid gzip+base64 JSON')
  }
  checkRecord(r)
  return r as ProviderRecord
}

// deno-lint-ignore no-explicit-any
export function checkRecord(r: any): void {
  const fail = (why: string) => {
    throw new RecordError(why)
  }
  if (typeof r !== 'object' || r === null || r.v !== 1) fail('unknown version')
  if (typeof r.id !== 'string' || !RESPONSE_ID.test(r.id)) fail('bad id')
  if (r.prev !== null && (typeof r.prev !== 'string' || !RESPONSE_ID.test(r.prev))) fail('bad prev')
  if (typeof r.chain !== 'string' || !HEX64.test(r.chain)) fail('bad chain')
  if (typeof r.digest !== 'string' || !HEX64.test(r.digest)) fail('bad digest')
  if (typeof r.session !== 'string' || !SESSION_ID.test(r.session)) fail('bad session')
  if (r.end !== 'turn' && r.end !== 'calls') fail('bad end')
  if (!Array.isArray(r.calls) || (r.end === 'turn') !== (r.calls.length === 0)) fail('bad calls')
  for (const c of r.calls) {
    if (typeof c !== 'object' || c === null || typeof c.id !== 'string' || !CALL_ID.test(c.id) || typeof c.name !== 'string' || !TOOL_NAME.test(c.name)) {
      fail('bad call')
    }
  }
  if (!Array.isArray(r.entries)) fail('bad entries')
  for (const e of r.entries) {
    if (typeof e !== 'string' || e.includes('\n') || e.includes('\r')) fail('bad entry')
    let o: unknown
    try {
      o = JSON.parse(e)
    } catch {
      fail('entry is not JSON')
    }
    if (typeof o !== 'object' || o === null || Array.isArray(o)) fail('entry is not an object')
  }
}

export function encodeThinking(t: ThinkingRecord): string {
  return THINKING_PREFIX + b64(new TextEncoder().encode(JSON.stringify(t)))
}

export function decodeThinking(s: string): ThinkingRecord | null {
  if (!s.startsWith(THINKING_PREFIX)) return null
  try {
    return JSON.parse(new TextDecoder().decode(unb64(s.slice(THINKING_PREFIX.length))))
  } catch {
    return null
  }
}

/** Canonical form of the items a record covers. Reasoning items are left out: they are the gateway's own. */
function canonPart(p: Part): unknown {
  return p.type === 'text' ? ['t', p.text] : ['i', p.mediaType, p.data]
}
export function canonItem(it: InItem): unknown | null {
  switch (it.kind) {
    case 'message':
      return ['m', it.role, it.parts.map(canonPart)]
    case 'function_call':
      return ['c', it.callId, it.name, it.arguments]
    case 'function_call_output':
      return ['o', it.callId, it.parts.map(canonPart)]
    case 'reasoning':
      return null
  }
}

export async function digestItems(items: InItem[]): Promise<string> {
  const canon = items.map(canonItem).filter((x) => x !== null)
  const bytes = new TextEncoder().encode(JSON.stringify(canon))
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return Array.from(h, (b) => b.toString(16).padStart(2, '0')).join('')
}

export async function sha256(s: string): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))
  return Array.from(h, (b) => b.toString(16).padStart(2, '0')).join('')
}

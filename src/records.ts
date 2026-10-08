import { checkReplay, type ReplayLine } from './replay.ts'
import { createHash } from 'node:crypto'
// Provider records: the Claude Code log entries behind each response, carried opaquely in a reasoning item's
// encrypted_content and kept in the response store. Replay templates plus sidecars reconstruct input log lines.
import type { CallAliases } from './call_ids.ts'
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
  /** Chain key: instructions, tools, model, effort and an explicit output cap. */
  chain: string
  /** Resolved chain instructions for continuations that omit the prompt (older records may lack it). */
  instructions?: string
  /** Client call ids bound to the original provider ids; every pair is one-to-one. */
  callAliases?: CallAliases
  /** Tool ids answered natively by Claude Code and omitted from Responses output (older records lack this). */
  nativeCalls?: string[]
  /** Claude Code session id. */
  session: string
  /** The chain's Claude Code device id (its config folder's userID): with the session id, metadata.user_id. */
  device: string
  /** How the response ended: a finished turn, or tool calls Claude Code waits on. */
  end: 'turn' | 'calls'
  calls: CallRef[]
  /** Digest of every item this record covers: the inputs since `prev` (any synthesized history too) and the outputs. */
  digest: string
  /** Log lines Claude Code (or the gateway, for rebuilt history and the interrupted-turn resume) wrote since `prev`, verbatim. */
  entries: string[]
  /** Payload-free log templates, interleaved with entries; inputs live in content-addressed sidecars. */
  replay?: ReplayLine[]
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
export const DEVICE_ID = HEX64

/** A new chain's device id: 64 hex digits, the shape Claude Code generates. */
export function newDeviceId(): string {
  const b = new Uint8Array(32)
  crypto.getRandomValues(b)
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
}
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
  if (r.instructions !== undefined && (typeof r.instructions !== 'string' || !r.instructions)) fail('bad instructions')
  if (r.callAliases !== undefined) {
    if (!Array.isArray(r.callAliases)) fail('bad call aliases')
    const clients = new Set<string>(), providers = new Set<string>()
    for (const pair of r.callAliases) {
      if (
        !Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || !pair[0] ||
        typeof pair[1] !== 'string' || !CALL_ID.test(pair[1])
      ) fail('bad call alias')
      if (clients.has(pair[0]) || providers.has(pair[1])) fail('call aliases are not one-to-one')
      clients.add(pair[0])
      providers.add(pair[1])
    }
  }
  if (
    r.nativeCalls !== undefined && (!Array.isArray(r.nativeCalls) ||
      r.nativeCalls.some((id: unknown) => typeof id !== 'string' || !CALL_ID.test(id)))
  ) fail('bad native calls')
  if (typeof r.digest !== 'string' || !HEX64.test(r.digest)) fail('bad digest')
  if (typeof r.session !== 'string' || !SESSION_ID.test(r.session)) fail('bad session')
  if (typeof r.device !== 'string' || !DEVICE_ID.test(r.device)) fail('bad device')
  if (r.end !== 'turn' && r.end !== 'calls') fail('bad end')
  if (!Array.isArray(r.calls) || (r.end === 'turn') !== (r.calls.length === 0)) fail('bad calls')
  for (const c of r.calls) {
    if (typeof c !== 'object' || c === null || typeof c.id !== 'string' || !CALL_ID.test(c.id) || typeof c.name !== 'string' || !TOOL_NAME.test(c.name)) {
      fail('bad call')
    }
  }
  if (!Array.isArray(r.entries)) fail('bad entries')
  if (r.replay !== undefined) checkReplay(r.replay, r.entries.length)
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

export class ItemDigest {
  private hash = createHash('sha256').update('[')
  private count = 0

  constructor(items: InItem[]) {
    this.append(items)
  }

  private append(items: InItem[]): void {
    for (const item of items) {
      const canon = canonItem(item)
      if (canon === null) continue
      if (this.count++) this.hash.update(',')
      this.hash.update(JSON.stringify(canon))
    }
  }

  finish(outputs: InItem[] = []): string {
    this.append(outputs)
    return this.hash.update(']').digest('hex')
  }
}

export function digestItems(items: InItem[]): Promise<string> {
  return Promise.resolve(new ItemDigest(items).finish())
}

export async function sha256(s: string): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))
  return Array.from(h, (b) => b.toString(16).padStart(2, '0')).join('')
}

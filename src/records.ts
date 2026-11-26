import { Buffer } from 'node:buffer'
import { checkReplay, type ReplayLine } from './replay.ts'
import { createHash, type Hash } from 'node:crypto'
// Provider records: the Claude Code log entries behind each response, carried opaquely in a reasoning item's
// encrypted_content and kept in the response store. Replay templates plus sidecars reconstruct input log lines.
import type { CallAliases } from './call_ids.ts'
import type { InItem, Part } from './api/request.ts'

export const RECORD_PREFIX = 'cc2r.record.v1.'
export const THINKING_PREFIX = 'cc2r.thinking.v1.'

// Every lane's provider-record envelope is gzip + base64 behind its own prefix. A transport that must keep an opaque
// record out of a terminal batch (WebSocket) asks here instead of naming one lane's constant.
const recordPrefixes = new Set<string>([RECORD_PREFIX])

/** Registers a lane's record prefix; the Claude lane's is always registered. */
export function registerRecordPrefix(prefix: string): void {
  recordPrefixes.add(prefix)
}

/** Whether this opaque reasoning content is a provider record of any lane. */
export function isRecord(content: string | undefined): boolean {
  if (!content) return false
  for (const prefix of recordPrefixes) if (content.startsWith(prefix)) return true
  return false
}

/** A lane's record as its envelope: the prefix, then gzip of the JSON. */
export async function packRecord(prefix: string, value: unknown): Promise<string> {
  return prefix + b64(await gzip(new TextEncoder().encode(JSON.stringify(value))))
}

/** Unpacks a record's envelope; anything that is not exactly one gzip'd JSON value is a RecordError. */
export async function unpackRecord(prefix: string, content: string): Promise<unknown> {
  try {
    return JSON.parse(new TextDecoder().decode(await gunzip(unb64(content.slice(prefix.length)))))
  } catch {
    throw new RecordError('not valid gzip+base64 JSON')
  }
}

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
  /** Resolved instructions, written on the chain head only. */
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
  /** Same covered items, but with function arguments compared as JSON values. Legacy records match by digest alone. */
  jsonArgumentDigest?: string
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
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64')
}
function unb64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export async function encodeRecord(r: ProviderRecord): Promise<string> {
  return packRecord(RECORD_PREFIX, r)
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
  const r: any = await unpackRecord(RECORD_PREFIX, s)
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
  if (r.callAliases !== undefined) checkCallAliases(r.callAliases)
  if (
    r.nativeCalls !== undefined && (!Array.isArray(r.nativeCalls) ||
      r.nativeCalls.some((id: unknown) => typeof id !== 'string' || !CALL_ID.test(id)))
  ) fail('bad native calls')
  if (typeof r.digest !== 'string' || !HEX64.test(r.digest)) fail('bad digest')
  if (r.jsonArgumentDigest !== undefined && (typeof r.jsonArgumentDigest !== 'string' || !HEX64.test(r.jsonArgumentDigest))) fail('bad JSON argument digest')
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

/** One-to-one client -> provider call-id pairs, as both lanes' records carry them. */
export function checkCallAliases(aliases: unknown): void {
  if (aliases === undefined) return
  if (!Array.isArray(aliases)) throw new RecordError('bad call aliases')
  const clients = new Set<string>(), providers = new Set<string>()
  for (const pair of aliases) {
    if (
      !Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || !pair[0] ||
      typeof pair[1] !== 'string' || !CALL_ID.test(pair[1])
    ) throw new RecordError('bad call alias')
    if (clients.has(pair[0]) || providers.has(pair[1])) throw new RecordError('call aliases are not one-to-one')
    clients.add(pair[0])
    providers.add(pair[1])
  }
}

export function encodeThinking(t: ThinkingRecord): string {
  return THINKING_PREFIX + b64(new TextEncoder().encode(JSON.stringify(t)))
}

export function decodeThinking(s: string): ThinkingRecord | null {
  if (!s.startsWith(THINKING_PREFIX)) return null
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(unb64(s.slice(THINKING_PREFIX.length))))
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ThinkingRecord : null
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

type ArgumentValue = null | boolean | number | string | ArgumentValue[] | { [key: string]: ArgumentValue }

function canonicalArguments(json: string): string {
  const tokens: string[] = []
  const pending: (string | { value: ArgumentValue })[] = [{ value: JSON.parse(json) }]
  while (pending.length) {
    const entry = pending.pop()!
    if (typeof entry === 'string') tokens.push(entry)
    else {
      const value = entry.value
      if (Array.isArray(value)) {
        tokens.push('[')
        pending.push(']')
        for (let i = value.length - 1; i >= 0; i--) {
          if (i < value.length - 1) pending.push(',')
          pending.push({ value: value[i] })
        }
      } else if (value !== null && typeof value === 'object') {
        tokens.push('{')
        pending.push('}')
        const keys = Object.keys(value).sort()
        for (let i = keys.length - 1; i >= 0; i--) {
          if (i < keys.length - 1) pending.push(',')
          pending.push({ value: value[keys[i]] }, ':', JSON.stringify(keys[i]))
        }
      } else {
        // A JSON exponent can overflow JS's Number; don't collapse infinity to null as JSON.stringify does.
        tokens.push(typeof value === 'number' ? String(value) : JSON.stringify(value))
      }
    }
  }
  return tokens.join('')
}

export class ItemDigest {
  private hash = createHash('sha256').update('[')
  private jsonArguments: Hash | undefined
  private count = 0

  constructor(items: InItem[]) {
    this.append(items)
  }

  private append(items: InItem[]): void {
    for (const item of items) {
      const canon = canonItem(item)
      if (canon === null) continue
      if (item.kind === 'function_call') this.jsonArguments ??= this.hash.copy()
      if (this.count++) {
        this.hash.update(',')
        this.jsonArguments?.update(',')
      }
      const exact = JSON.stringify(canon)
      this.hash.update(exact)
      this.jsonArguments?.update(
        item.kind === 'function_call' ? JSON.stringify(['c', item.callId, item.name, canonicalArguments(item.arguments)]) : exact,
      )
    }
  }

  finish(outputs: InItem[] = []): Pick<ProviderRecord, 'digest' | 'jsonArgumentDigest'> {
    this.append(outputs)
    const digest = this.hash.update(']').digest('hex')
    const jsonArgumentDigest = this.jsonArguments?.update(']').digest('hex')
    return jsonArgumentDigest === undefined ? { digest } : { digest, jsonArgumentDigest }
  }
}

export async function sha256(s: string): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))
  return Array.from(h, (b) => b.toString(16).padStart(2, '0')).join('')
}

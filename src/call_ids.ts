import type { InItem } from './api/request.ts'
import { ItemDigest } from './records.ts'

export type CallAliases = [string, string][]

function bind(map: Map<string, string>, reverse: Map<string, string>, client: string, provider: string): boolean {
  if (map.has(client)) return map.get(client) === provider
  if (reverse.has(provider)) return false
  map.set(client, provider)
  reverse.set(provider, client)
  return true
}

export function remapItems(items: InItem[], aliases: CallAliases): InItem[] {
  const map = new Map(aliases)
  return items.map((it) => it.kind === 'function_call' || it.kind === 'function_call_output' ? { ...it, callId: map.get(it.callId) ?? it.callId } : it)
}

/** Binds the client's call ids to the record's provider ids (one-to-one, consistently) and verifies the digest. */
export function matchItems(
  items: InItem[],
  record: { digest: string; jsonArgumentDigest?: string },
  providerCalls: string[],
  aliases: CallAliases,
): CallAliases | null {
  const calls = items.filter((it) => it.kind === 'function_call')
  if (calls.length !== providerCalls.length) return null
  const map = new Map(aliases)
  const reverse = new Map(aliases.map(([client, provider]) => [provider, client]))
  for (let i = 0; i < calls.length; i++) if (!bind(map, reverse, calls[i].callId, providerCalls[i])) return null
  if (items.some((it) => it.kind === 'function_call_output' && !map.has(it.callId))) return null
  const next = [...map.entries()]
  const { digest, jsonArgumentDigest } = new ItemDigest(remapItems(items, next)).finish()
  return record.digest === digest || (record.jsonArgumentDigest !== undefined && record.jsonArgumentDigest === jsonArgumentDigest) ? next : null
}

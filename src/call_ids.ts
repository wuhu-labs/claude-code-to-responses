import { recordLogTemplates } from './replay.ts'
import type { InItem } from './api/request.ts'
import { digestItems, type ProviderRecord } from './records.ts'

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

export async function matchRecordItems(items: InItem[], record: ProviderRecord, aliases: CallAliases): Promise<CallAliases | null> {
  const calls = items.filter((it) => it.kind === 'function_call')
  const original: string[] = []
  const native = new Set(record.nativeCalls ?? [])
  for (const line of recordLogTemplates(record)) {
    const entry = JSON.parse(line.text)
    if (entry.type !== 'assistant' || !Array.isArray(entry.message?.content)) continue
    for (const block of entry.message.content) {
      if (block.type === 'tool_use' && typeof block.id === 'string' && !native.has(block.id)) original.push(block.id)
    }
  }
  if (calls.length !== original.length) return null
  const map = new Map(aliases)
  const reverse = new Map(aliases.map(([client, provider]) => [provider, client]))
  for (let i = 0; i < calls.length; i++) if (!bind(map, reverse, calls[i].callId, original[i])) return null
  if (items.some((it) => it.kind === 'function_call_output' && !map.has(it.callId))) return null
  const next = [...map.entries()]
  return record.digest === await digestItems(remapItems(items, next)) ? next : null
}

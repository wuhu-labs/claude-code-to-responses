// Matching a client's full history against the provider records it carries. Both lanes use this: a lane supplies how
// it reads a record, whether the record continues the chain the request asks for, its provider call ids (for call-id
// renaming) and how it replays the record's state. Groups the records do not cover come back as `synth`: the Claude
// lane renders them, the agy lane refuses the request.
import type { InItem } from './api/request.ts'
import { type CallAliases, matchItems, remapItems } from './call_ids.ts'

export interface Group {
  inputs: InItem[]
  outputs: InItem[]
}

export interface MatchRecord {
  id: string
  prev: string | null
  digest: string
  jsonArgumentDigest?: string
  end: 'turn' | 'calls'
  calls: { id: string; name: string }[]
}

export interface Head {
  responseId: string
  end: 'turn' | 'calls'
  calls: { id: string; name: string }[]
}

export interface HistoryOptions<R extends MatchRecord, S> {
  /** The lane's record carried by an encrypted_content string; null when the string is not this lane's record. */
  decode(content: string, group: number): Promise<R | null>
  /** The provider session (Claude Code session, agy conversation) the response belongs to; a run never mixes two. */
  session(record: R): string
  /** Whether the record continues the chain this request asks for (same instructions, tools and model). */
  continues(record: R): boolean
  /** The record's provider call ids in order, or null when its state cannot be read. */
  providerCalls(record: R): string[] | null
  /** The lane's state for a matched record, replayed from the items it covers. */
  state(record: R, items: InItem[], aliases: CallAliases): Promise<S>
}

export interface Match<R, S> {
  used: { record: R; state: S }[]
  aliases: CallAliases
  /** Groups no record covers, oldest first. */
  synth: Group[]
  /** The new input after aliasing: the client's items since the last covered response. */
  tail: InItem[]
  /** The last matched response, or null when nothing in the history is covered. */
  head: Head | null
}

/** Splits a history into response groups (the inputs since the previous response, then its outputs) and the new tail. */
export function segment(items: InItem[]): { groups: Group[]; tail: InItem[] } {
  const groups: Group[] = []
  let cur: Group = { inputs: [], outputs: [] }
  for (const it of items) {
    if (isOutput(it)) cur.outputs.push(it)
    else {
      if (cur.outputs.length) {
        groups.push(cur)
        cur = { inputs: [], outputs: [] }
      }
      cur.inputs.push(it)
    }
  }
  if (cur.outputs.length) {
    groups.push(cur)
    return { groups, tail: [] }
  }
  return { groups, tail: cur.inputs }
}

export function isOutput(i: InItem): boolean {
  return i.kind === 'reasoning' || i.kind === 'function_call' || (i.kind === 'message' && i.role === 'assistant')
}

/**
 * The longest run of groups whose records chain onto each other and match their items. A record that does not continue
 * the run (another chain, an edited history) is ignored and its group synthesized, unless a later record covers it.
 */
export async function matchHistory<R extends MatchRecord, S>(
  groups: Group[],
  input: InItem[],
  o: HistoryOptions<R, S>,
): Promise<Match<R, S>> {
  const used: { record: R; state: S }[] = []
  let pending: Group[] = []
  let head: Head | null = null
  let session: string | null = null
  let aliases: CallAliases = []
  const reset = (to: number) => {
    used.length = 0
    aliases = []
    head = null
    session = null
    pending = groups.slice(0, to)
  }
  for (let gi = 0; gi < groups.length; gi++) {
    const group = groups[gi]
    pending.push(group)
    // a client may repeat an item it already sent; one record counted twice is still one record
    const encrypted = [...new Set(group.outputs.filter((i) => i.kind === 'reasoning' && i.encrypted).map((i) => (i as { encrypted: string }).encrypted))]
    const records = (await Promise.all(encrypted.map((e) => o.decode(e, gi)))).filter((r) => r !== null)
    if (records.length === 0) continue
    const record = records[records.length - 1]!
    const covers = pending.flatMap((x) => [...x.inputs, ...x.outputs])
    const candidate = records.length === 1 && o.continues(record) && record.prev === (head?.responseId ?? null) &&
      (session === null || o.session(record) === session)
    const providerCalls = candidate ? o.providerCalls(record) : null
    const matched = providerCalls === null ? null : matchItems(covers, record, providerCalls, aliases)
    if (candidate && matched === null) reset(gi + 1)
    if (matched === null) continue
    aliases = matched
    used.push({ record, state: await o.state(record, covers, aliases) })
    head = { responseId: record.id, end: record.end, calls: record.calls }
    session = o.session(record)
    pending = []
  }
  const { tail: pure, groups: all } = segment(input)
  // an output for a call no function_call in this input names sends the whole history back to synthesis
  const clientCalls = new Set(input.filter((it) => it.kind === 'function_call').map((it) => it.callId))
  if (pure.some((it) => it.kind === 'function_call_output' && !clientCalls.has(it.callId))) reset(all.length)
  return {
    used,
    aliases,
    synth: pending.map((g) => ({ inputs: remapItems(g.inputs, aliases), outputs: remapItems(g.outputs, aliases) })),
    tail: remapItems(pure, aliases),
    head,
  }
}

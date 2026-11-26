// Matching a client's full history against the provider records it carries. Both lanes use this: a lane supplies how
// it reads a record, whether the record continues the chain the request asks for, its provider call ids (for call-id
// renaming) and how it replays the record's state. Groups the records do not cover come back as `synth`: the Claude
// lane renders them, the agy lane refuses the request.
import type { InItem } from './api/request.ts'
import { type CallAliases, matchItems, remapItems } from './call_ids.ts'
import { invalid } from './errors.ts'

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
 * The longest run of groups whose records chain onto each other and match their items. A group no record covers is
 * synthesized (or refused by a lane that cannot represent it). A record that does chain onto the run but whose items
 * disagree with what it covers is positive evidence of a changed prefix: that is a 400, never a silent synthesis.
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
  const reset = () => {
    used.length = 0
    aliases = []
    head = null
    session = null
    pending = [...groups]
  }
  const known = new Map<string, R>()
  for (let gi = 0; gi < groups.length; gi++) {
    const group = groups[gi]
    pending.push(group)
    // a client may repeat an item it already sent; one record counted twice is still one record
    const encrypted = [...new Set(group.outputs.filter((i) => i.kind === 'reasoning' && i.encrypted).map((i) => (i as { encrypted: string }).encrypted))]
    const records = (await Promise.all(encrypted.map((e) => o.decode(e, gi)))).filter((r) => r !== null)
    if (records.length === 0) continue
    // Two readable records whose own prev links disagree with the order they were sent in are a visible contradiction:
    // a response cannot follow its own parent. A response sent twice is still one record and keeps its first position.
    for (const record of records) {
      if (known.has(record.id)) continue
      const child = [...known.values()].find((r) => r.prev === record.id)
      if (child) throw invalid('input', `The history puts response '${child.id}' before its parent '${record.id}'.`, 'history_mismatch')
      known.set(record.id, record)
    }
    const record = records[records.length - 1]!
    const covers = pending.flatMap((x) => [...x.inputs, ...x.outputs])
    const candidate = records.length === 1 && o.continues(record) && record.prev === (head?.responseId ?? null) &&
      (session === null || o.session(record) === session)
    const providerCalls = candidate ? o.providerCalls(record) : null
    const matched = providerCalls === null ? null : matchItems(covers, record, providerCalls, aliases)
    // The record names this exact parent and continues the run, but the items it covers are not the ones it was issued
    // for. No lookup can make that true; the client must drop the reasoning it contradicts.
    if (candidate && providerCalls !== null && matched === null) {
      throw invalid(
        'input',
        `The history carries the reasoning record of response '${record.id}', but the input it covers is not the input it was issued for. ` +
          'A changed prefix cannot keep its old reasoning: drop that reasoning item and the later ones, or start a new conversation.',
        'history_mismatch',
      )
    }
    if (matched === null) continue
    aliases = matched
    used.push({ record, state: await o.state(record, covers, aliases) })
    head = { responseId: record.id, end: record.end, calls: record.calls }
    session = o.session(record)
    pending = []
  }
  const { tail: pure } = segment(input)
  // an output for a call no function_call in this input names sends the whole history back to synthesis
  const clientCalls = new Set(input.filter((it) => it.kind === 'function_call').map((it) => it.callId))
  if (pure.some((it) => it.kind === 'function_call_output' && !clientCalls.has(it.callId))) reset()
  return {
    used,
    aliases,
    synth: pending.map((g) => ({ inputs: remapItems(g.inputs, aliases), outputs: remapItems(g.outputs, aliases) })),
    tail: remapItems(pure, aliases),
    head,
  }
}

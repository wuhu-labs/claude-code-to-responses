import { isDeepStrictEqual } from 'node:util'
import { count, type JsonObject, object, string, toolArgs, type ToolSignature } from './wire.ts'

export interface Tokens {
  input_tokens: number
  cached_read_tokens: number
  cached_write_tokens: number
  output_tokens: number
  thought_tokens: number | null
}

export interface Planner {
  index: number
  text: string
  thinking: string
  usage: Tokens | null
  calls: ToolSignature[]
}

export function sameCall(a: ToolSignature, b: ToolSignature): boolean {
  return a.name === b.name && isDeepStrictEqual(a.args, b.args)
}

export function promptTokens(value: unknown): Tokens | null {
  const u = object(value)
  const input = count(u?.inputTokens), output = count(u?.outputTokens)
  if (input === undefined || output === undefined) return null
  return {
    input_tokens: input,
    cached_read_tokens: count(u?.cachedReadTokens) ?? 0,
    cached_write_tokens: count(u?.cachedWriteTokens) ?? 0,
    output_tokens: output,
    thought_tokens: count(u?.thoughtTokens) ?? null,
  }
}

function planner(row: JsonObject, full: boolean): Planner | null {
  const index = count(row.step_index)
  if (row.type !== 'PLANNER_RESPONSE' || index === undefined) return null
  const calls: ToolSignature[] = []
  try {
    for (const raw of Array.isArray(row.tool_calls) ? row.tool_calls : []) {
      const tool = object(raw), name = string(tool?.name), args = object(tool?.args)
      if (!name || !args) return null
      const plain = toolArgs(args)
      calls.push({
        name,
        args: full ? plain : Object.fromEntries(
          Object.entries(plain).map(([k, v]) => {
            if (typeof v !== 'string') throw new Error('unknown transcript argument encoding')
            return [k, JSON.parse(v)]
          }),
        ),
      })
    }
  } catch {
    return null
  }
  const input = count(row.input_tokens), output = count(row.output_tokens)
  const text = string(row.content) ?? '', thinking = string(row.thinking) ?? ''
  return {
    index,
    text,
    thinking,
    calls,
    usage: input !== undefined && output !== undefined
      ? {
        input_tokens: input,
        cached_read_tokens: count(row.cache_read_tokens) ?? 0,
        cached_write_tokens: count(row.cache_write_tokens) ?? 0,
        output_tokens: output,
        thought_tokens: count(row.thought_tokens) ?? (thinking ? null : 0),
      }
      : null,
  }
}

async function rows(path: string): Promise<JsonObject[]> {
  let text: string
  try {
    text = await Deno.readTextFile(path)
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return []
    throw e
  }
  const out: JsonObject[] = []
  for (const line of text.split('\n')) {
    if (!line) continue
    try {
      const parsed = object(JSON.parse(line))
      if (parsed) out.push(parsed)
    } catch { /* a writer can still be appending this line */ }
  }
  return out
}

export class Transcript {
  private readonly dir: string
  constructor(gemini: string, session: string) {
    this.dir = `${gemini}/antigravity-cli/brain/${session}/.system_generated/logs`
  }

  /** A cursor is a step index, not a timestamp; identical calls in older inferences cannot match. */
  async head(): Promise<number> {
    const [brief, full] = await Promise.all([rows(`${this.dir}/transcript.jsonl`), rows(`${this.dir}/transcript_full.jsonl`)])
    return [...brief, ...full].reduce((max, row) => Math.max(max, count(row.step_index) ?? -1), -1)
  }

  async find(after: number, match: (line: Planner) => boolean, signal: AbortSignal, before = Infinity): Promise<Planner | null> {
    const deadline = performance.now() + 350
    do {
      signal.throwIfAborted()
      const candidates = (await this.read()).filter((p) => p.index > after && p.index < before && match(p))
      let latest: Planner | null = null
      for (const p of candidates) if (!latest || latest.index < p.index) latest = p
      if (latest) return latest
      signal.throwIfAborted()
      if (performance.now() >= deadline) break
      await new Promise((resolve) => setTimeout(resolve, 12))
    } while (performance.now() < deadline)
    return null
  }

  /**
   * Every planner line after a cursor, oldest first, once one without calls is in: a turn agy answered some calls
   * itself (`read_file`) made several inferences, and the response covers all of them.
   */
  async lines(after: number, signal: AbortSignal): Promise<Planner[]> {
    const deadline = performance.now() + 350
    do {
      signal.throwIfAborted()
      const all = (await this.read()).filter((p) => p.index > after).sort((a, b) => a.index - b.index)
      if (all.some((p) => p.calls.length === 0)) return all
      if (performance.now() >= deadline) break
      await new Promise((resolve) => setTimeout(resolve, 12))
    } while (performance.now() < deadline)
    return []
  }

  /** Every planner line the two transcripts hold, one per inference, the full transcript's copy winning. */
  private async read(): Promise<Planner[]> {
    const [brief, full] = await Promise.all([rows(`${this.dir}/transcript.jsonl`), rows(`${this.dir}/transcript_full.jsonl`)])
    const candidates = new Map<number, Planner>()
    for (const [data, rich] of [[brief, false], [full, true]] as const) {
      for (const row of data) {
        const p = planner(row, rich)
        if (p) candidates.set(p.index, p)
      }
    }
    return [...candidates.values()]
  }
}

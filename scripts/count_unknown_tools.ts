// Counts Claude Code's native "No such tool available" tool results in a gateway's Claude Code transcripts (WUHU-645):
// per UTC day, per Claude session, and per missing tool name. Read-only: it opens files for reading and nothing else,
// so it runs with `--allow-read` alone.
//
//   deno run --allow-read scripts/count_unknown_tools.ts --state-dir /var/lib/ccgw/state-claude [--since ISO] [--top 20] [--json]
//
// The transcripts are `<state-dir>/claude/config/projects/<working folder>/<session>.jsonl` (README, `--state-dir`).
// A rebuild rewrites a session's log from its stored records, timestamps included, so each result is counted once
// by session and tool_use_id.

// deno-lint-ignore no-explicit-any
type Json = any

export const MARKER = 'No such tool available'

export interface Hit {
  session: string
  toolUseId: string
  /** The entry's own timestamp (ISO, UTC). */
  timestamp: string
  /** The name the model called, as Claude Code reports it. */
  name: string
}

export interface Counts {
  transcripts: number
  total: number
  days: [string, number][]
  sessions: { session: string; count: number; first: string; last: string; names: [string, number][] }[]
  names: [string, number][]
}

export function projectsDir(stateDir: string): string {
  return `${stateDir.replace(/\/$/, '')}/claude/config/projects`
}

async function* transcripts(dir: string): AsyncGenerator<string> {
  let entries: Deno.DirEntry[]
  try {
    entries = await Array.fromAsync(Deno.readDir(dir))
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return
    throw e
  }
  entries.sort((a, b) => a.name.localeCompare(b.name))
  for (const e of entries) {
    const path = `${dir}/${e.name}`
    if (e.isDirectory) yield* transcripts(path)
    else if (e.isFile && e.name.endsWith('.jsonl')) yield path
  }
}

async function* lines(path: string): AsyncGenerator<string> {
  const file = await Deno.open(path, { read: true })
  let rest = ''
  for await (const chunk of file.readable.pipeThrough(new TextDecoderStream())) {
    const parts = (rest + chunk).split('\n')
    rest = parts.pop()!
    yield* parts
  }
  if (rest) yield rest
}

/** Claude Code 2.1.284's own answer to a call of a tool it doesn't have: an error result whose whole content is this
 * string (src/claude/entries.ts `unknownToolEntry`, probe/probe_test.ts). A result that merely quotes it is no hit. */
const NATIVE_ERROR = /^<tool_use_error>Error: No such tool available: (\S+)<\/tool_use_error>$/

/** The unknown-tool results of one transcript line (a user entry's tool_result blocks). */
export function hitsOf(line: string, fallbackSession: string): Hit[] {
  if (!line.includes(MARKER)) return []
  let e: Json
  try {
    e = JSON.parse(line)
  } catch {
    return []
  }
  if (e?.type !== 'user' || !Array.isArray(e.message?.content)) return []
  const session = typeof e.sessionId === 'string' ? e.sessionId : fallbackSession
  const timestamp = typeof e.timestamp === 'string' ? e.timestamp : ''
  const hits: Hit[] = []
  for (const b of e.message.content) {
    if (b?.type !== 'tool_result' || b.is_error !== true || typeof b.tool_use_id !== 'string' || typeof b.content !== 'string') continue
    const m = b.content.match(NATIVE_ERROR)
    if (m) hits.push({ session, toolUseId: b.tool_use_id, timestamp, name: m[1] })
  }
  return hits
}

const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1)
const byCount = (m: Map<string, number>): [string, number][] => [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))

export async function count(stateDir: string, opts: { since?: string } = {}): Promise<Counts> {
  const since = opts.since ? new Date(opts.since).getTime() : null
  if (since !== null && Number.isNaN(since)) throw new Error(`--since is not a date: ${opts.since}`)
  const seen = new Map<string, Hit>()
  let files = 0
  for await (const path of transcripts(projectsDir(stateDir))) {
    files++
    const fallback = path.slice(path.lastIndexOf('/') + 1).replace(/\.jsonl$/, '')
    for await (const line of lines(path)) {
      for (const h of hitsOf(line, fallback)) {
        if (since !== null && !(new Date(h.timestamp).getTime() >= since)) continue
        const key = `${h.session}\u0000${h.toolUseId}`
        if (!seen.has(key)) seen.set(key, h)
      }
    }
  }
  const days = new Map<string, number>(), names = new Map<string, number>()
  const sessions = new Map<string, { hits: Hit[]; names: Map<string, number> }>()
  for (const h of seen.values()) {
    bump(days, h.timestamp.slice(0, 10) || 'unknown')
    bump(names, h.name)
    const s = sessions.get(h.session) ?? { hits: [] as Hit[], names: new Map<string, number>() }
    s.hits.push(h)
    bump(s.names, h.name)
    sessions.set(h.session, s)
  }
  return {
    transcripts: files,
    total: seen.size,
    days: [...days].sort((a, b) => a[0].localeCompare(b[0])),
    sessions: [...sessions].map(([session, s]) => {
      const ts = s.hits.map((h) => h.timestamp).sort()
      return { session, count: s.hits.length, first: ts[0], last: ts.at(-1)!, names: byCount(s.names) }
    }).sort((a, b) => b.count - a.count || a.session.localeCompare(b.session)),
    names: byCount(names),
  }
}

export function render(c: Counts, stateDir: string, top: number, since?: string): string {
  const out = [`"${MARKER}" tool results in ${c.transcripts} Claude Code transcripts under ${projectsDir(stateDir)}${since ? ` since ${since}` : ''}`]
  out.push('', 'per day (UTC):')
  for (const [day, n] of c.days) out.push(`  ${day}  ${n}`)
  out.push(`  total       ${c.total}`)
  out.push('', `top ${Math.min(top, c.sessions.length)} of ${c.sessions.length} sessions:`)
  for (const s of c.sessions.slice(0, top)) {
    const names = s.names.slice(0, 5).map(([n, k]) => `${n} ${k}`).join(', ')
    out.push(`  ${s.session}  ${s.count}  ${s.first} .. ${s.last}  ${names}`)
  }
  out.push('', 'called names:')
  for (const [n, k] of c.names.slice(0, top)) out.push(`  ${n}  ${k}`)
  return out.join('\n')
}

if (import.meta.main) {
  const args = [...Deno.args]
  const take = (flag: string): string | undefined => {
    const i = args.indexOf(flag)
    if (i < 0) return undefined
    const v = args[i + 1]
    if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value`)
    args.splice(i, 2)
    return v
  }
  const stateDir = take('--state-dir')
  const since = take('--since')
  const top = Number(take('--top') ?? 20)
  const json = args.includes('--json')
  if (json) args.splice(args.indexOf('--json'), 1)
  if (!stateDir || args.length || !Number.isInteger(top) || top < 1) {
    console.error('usage: count_unknown_tools.ts --state-dir DIR [--since ISO] [--top N] [--json]')
    Deno.exit(2)
  }
  const c = await count(stateDir, { since })
  console.log(json ? JSON.stringify(c, null, 2) : render(c, stateDir, top, since))
}

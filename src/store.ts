// The response store: response id -> provider record, one JSON file per response under <state>/responses.
// It survives gateway restarts; a request with a known previous_response_id rebuilds Claude Code's log from it.
import type { ProviderRecord } from './records.ts'

export class ResponseStore {
  readonly dir: string
  readonly tailDir: string
  constructor(stateDir: string) {
    this.dir = `${stateDir}/responses`
    this.tailDir = `${stateDir}/tails`
    Deno.mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    Deno.mkdirSync(this.tailDir, { recursive: true, mode: 0o700 })
  }

  /** Log lines Claude Code wrote after a response's record and before its process went away. */
  tail(id: string): string[] {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) return []
    try {
      return JSON.parse(Deno.readTextFileSync(`${this.tailDir}/${id}.json`))
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) return []
      throw e
    }
  }

  putTail(id: string, lines: string[]): void {
    const p = `${this.tailDir}/${this.path(id).replace(/^.*\//, '')}`
    Deno.writeTextFileSync(`${p}.tmp`, JSON.stringify(lines), { mode: 0o600 })
    Deno.renameSync(`${p}.tmp`, p)
  }

  private path(id: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`bad response id ${id}`)
    return `${this.dir}/${id}.json`
  }

  get(id: string): ProviderRecord | null {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) return null
    try {
      return JSON.parse(Deno.readTextFileSync(this.path(id)))
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) return null
      throw e
    }
  }

  has(id: string): boolean {
    return this.get(id) !== null
  }

  put(r: ProviderRecord): void {
    const p = this.path(r.id)
    const tmp = `${p}.tmp`
    Deno.writeTextFileSync(tmp, JSON.stringify(r), { mode: 0o600 })
    Deno.renameSync(tmp, p)
  }

  /** The chain of records ending at `id`, oldest first; null if any link is missing. */
  chain(id: string): ProviderRecord[] | null {
    const out: ProviderRecord[] = []
    let cur: string | null = id
    const seen = new Set<string>()
    while (cur !== null) {
      if (seen.has(cur)) return null
      seen.add(cur)
      const r = this.get(cur)
      if (!r) return null
      out.push(r)
      cur = r.prev
    }
    return out.reverse()
  }
}

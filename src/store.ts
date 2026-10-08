import { createHash } from 'node:crypto'
// The response store: response id -> provider record, one JSON file per response under <state>/responses.
// It survives gateway restarts; a request with a known previous_response_id rebuilds Claude Code's log from it.
import type { ProviderRecord } from './records.ts'

export class ResponseStore {
  readonly dir: string
  readonly tailDir: string
  readonly payloadDir: string
  readonly aliasDir: string
  constructor(stateDir: string) {
    this.dir = `${stateDir}/responses`
    this.tailDir = `${stateDir}/tails`
    this.payloadDir = `${stateDir}/payloads`
    this.aliasDir = `${stateDir}/payload-aliases`
    Deno.mkdirSync(this.payloadDir, { recursive: true, mode: 0o700 })
    Deno.mkdirSync(this.aliasDir, { recursive: true, mode: 0o700 })
    Deno.mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    Deno.mkdirSync(this.tailDir, { recursive: true, mode: 0o700 })
  }

  getPayload(hash: string): any | undefined {
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('bad payload hash')
    try {
      let actual = hash
      try {
        actual = Deno.readTextFileSync(`${this.aliasDir}/${hash}`)
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error
      }
      if (!/^[0-9a-f]{64}$/.test(actual)) throw new Error('bad payload alias')
      const text = Deno.readTextFileSync(`${this.payloadDir}/${actual}`)
      if (createHash('sha256').update(text).digest('hex') !== actual) throw new Error('payload sidecar hash mismatch')
      return JSON.parse(text)
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return undefined
      throw error
    }
  }

  putPayload(value: any): string {
    const text = JSON.stringify(value)
    const hash = createHash('sha256').update(text).digest('hex')
    const path = `${this.payloadDir}/${hash}`
    try {
      Deno.statSync(path)
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error
      Deno.writeTextFileSync(`${path}.tmp`, text, { mode: 0o600 })
      Deno.renameSync(`${path}.tmp`, path)
    }
    return hash
  }

  aliasPayload(old: string, actual: string): void {
    if (![old, actual].every((hash) => /^[0-9a-f]{64}$/.test(hash))) throw new Error('bad payload hash')
    const path = `${this.aliasDir}/${old}`
    Deno.writeTextFileSync(`${path}.tmp`, actual, { mode: 0o600 })
    Deno.renameSync(`${path}.tmp`, path)
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

  /** Roll back a just-written response whose synchronous terminal enqueue was refused. */
  remove(id: string): void {
    Deno.removeSync(this.path(id))
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

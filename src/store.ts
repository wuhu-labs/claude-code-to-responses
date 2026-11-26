import { createHash } from 'node:crypto'
// The response store: one JSON file per response under <state>/responses, id -> provider record. It survives gateway
// restarts; a request naming a known response rebuilds its lane's state from the chain of records. Both lanes use
// RecordStore; the Claude lane adds the payload sidecars and tails its log replay needs.
import { type ProviderRecord, RecordError } from './records.ts'

const ID = /^[A-Za-z0-9_-]+$/

export class RecordStore<R extends { id: string; prev: string | null }> {
  readonly dir: string
  constructor(stateDir: string) {
    this.dir = `${stateDir}/responses`
    Deno.mkdirSync(this.dir, { recursive: true, mode: 0o700 })
  }

  private path(id: string): string {
    if (!ID.test(id)) throw new Error(`bad response id ${id}`)
    return `${this.dir}/${id}.json`
  }

  get(id: string): R | null {
    if (!ID.test(id)) return null
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

  put(r: R): void {
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
  chain(id: string): R[] | null {
    const out: R[] = []
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

export class ResponseStore extends RecordStore<ProviderRecord> {
  readonly tailDir: string
  readonly payloadDir: string
  readonly aliasDir: string

  constructor(stateDir: string) {
    super(stateDir)
    this.tailDir = `${stateDir}/tails`
    this.payloadDir = `${stateDir}/payloads`
    this.aliasDir = `${stateDir}/payload-aliases`
    Deno.mkdirSync(this.payloadDir, { recursive: true, mode: 0o700 })
    Deno.mkdirSync(this.aliasDir, { recursive: true, mode: 0o700 })
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
      if (createHash('sha256').update(text).digest('hex') !== actual) throw new RecordError('payload sidecar hash mismatch')
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
    if (!ID.test(id)) return []
    try {
      return JSON.parse(Deno.readTextFileSync(`${this.tailDir}/${id}.json`))
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) return []
      throw e
    }
  }

  putTail(id: string, lines: string[]): void {
    const p = `${this.tailDir}/${id}.json`
    Deno.writeTextFileSync(`${p}.tmp`, JSON.stringify(lines), { mode: 0o600 })
    Deno.renameSync(`${p}.tmp`, p)
  }
}

import type { FnTool, InItem } from '../api/request.ts'
import type { Call } from './output.ts'
import { safeId } from './wire.ts'

export type Record = {
  id: string
  prev: string | null
  chain: string
  session: string
  instructions: string
  model: string
  tools: FnTool[]
  input: InItem[]
  output: InItem[]
  calls: Call[]
}

/** Only a clean head may reuse the native session. An interrupted attempt may have advanced agy's own DB. */
type Head = { response: string | null; dirty: boolean }

function read<T>(path: string): T | null {
  try {
    return JSON.parse(Deno.readTextFileSync(path)) as T
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return null
    throw e
  }
}

export function put(path: string, value: unknown) {
  Deno.writeTextFileSync(`${path}.tmp`, JSON.stringify(value), { mode: 0o600 })
  Deno.renameSync(`${path}.tmp`, path)
}

export class Store {
  constructor(readonly root: string) {
    for (const name of ['workspaces', 'responses']) Deno.mkdirSync(`${root}/${name}`, { recursive: true, mode: 0o700 })
  }

  workspace(chain: string) {
    if (!safeId(chain)) throw new Error('Invalid workspace ID')
    return `${this.root}/workspaces/${chain}`
  }

  chains(): Set<string> {
    return new Set(Array.from(Deno.readDirSync(`${this.root}/workspaces`)).filter((f) => f.isDirectory && safeId(f.name)).map((f) => f.name))
  }

  get(id: string): Record | null {
    return safeId(id) ? read<Record>(`${this.root}/responses/${id}.json`) : null
  }

  head(chain: string): Head | null {
    return read<Head>(`${this.workspace(chain)}/head.json`)
  }

  dirty(chain: string) {
    put(`${this.workspace(chain)}/head.json`, { response: this.head(chain)?.response ?? null, dirty: true } satisfies Head)
  }

  /** Whole terminal batch was preflighted. On a refused enqueue the attempt is not a continuation point. */
  commit(record: Record, send: () => boolean): boolean {
    const path = `${this.root}/responses/${record.id}.json`
    const prior = this.head(record.chain)
    put(path, record)
    try {
      put(`${this.workspace(record.chain)}/head.json`, { response: record.id, dirty: false } satisfies Head)
      if (send()) return true
    } catch (e) {
      Deno.removeSync(path)
      if (prior) put(`${this.workspace(record.chain)}/head.json`, prior)
      throw e
    }
    Deno.removeSync(path)
    if (prior) put(`${this.workspace(record.chain)}/head.json`, prior)
    return false
  }

  history(head: Record): InItem[] {
    const chain: Record[] = [], seen = new Set<string>()
    let record: Record | null = head
    while (record) {
      if (seen.has(record.id)) throw new Error('Cyclic agy response history')
      seen.add(record.id)
      chain.push(record)
      if (!record.prev) break
      record = this.get(record.prev)
      if (!record) throw new Error('Incomplete agy response history')
    }
    return chain.reverse().flatMap((r) => [...r.input, ...r.output])
  }
}

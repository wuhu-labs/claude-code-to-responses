import { createHash } from 'node:crypto'
import type { InItem } from './api/request.ts'
import { canonItem, type ProviderRecord, RecordError } from './records.ts'

type Json = any
type Path = number[]
interface InputRef {
  path: Path
  image?: true
  prefix?: string
  json?: true
}
interface Ref extends Partial<InputRef> {
  hash: string
}
export interface ReplayLine {
  at: number
  line: string
}
export interface PayloadStore {
  getPayload(hash: string): Json | undefined
  putPayload(value: Json): string
  aliasPayload(old: string, actual: string): void
}
const marker = '$cc2r_input'
const hash = (value: Json): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')

export class ReplayIndex {
  private refs = new Map<string, InputRef>()
  private images: InputRef[] = []

  constructor(items: InItem[]) {
    let index = 0
    for (const item of items) {
      if (canonItem(item) === null) continue
      if (item.kind === 'message' || item.kind === 'function_call_output') {
        const partsAt = 2
        item.parts.forEach((part, n) => {
          if (part.type === 'image') {
            const ref: InputRef = { path: [index, partsAt, n], image: true }
            this.images.push(ref)
            this.refs.set(hash({ type: 'base64', media_type: part.mediaType, data: part.data }), ref)
          } else {
            const ref = { path: [index, partsAt, n, 1] }
            this.refs.set(hash(part.text), ref)
            this.refs.set(hash(' ' + part.text), { ...ref, prefix: ' ' })
          }
        })
      }
      if (item.kind === 'function_call') this.refs.set(hash(JSON.parse(item.arguments)), { path: [index, 3], json: true })
      index++
    }
  }

  compact(lines: string[], generated: Set<string>, store: PayloadStore): { entries: string[]; replay: ReplayLine[] } {
    const entries: string[] = [], replay: ReplayLine[] = []
    let imageAt = 0
    const replace = (value: Json): Json => {
      if (Array.isArray(value)) return value.map(replace)
      if (typeof value === 'string') {
        const ref = this.refs.get(hash(value))
        return ref || value.length > 1024 ? { [marker]: { hash: store.putPayload(value), ...ref } } : value
      }
      if (!value || typeof value !== 'object') return value
      if (value.type === 'image' && value.source?.type === 'base64') {
        const source = value.source
        const ref = this.refs.get(hash(source)) ?? this.images[imageAt]
        imageAt++
        if (!ref) throw new RecordError('image log entry has no matching request input')
        this.refs.set(hash(source), ref)
        return { ...value, source: { [marker]: { hash: store.putPayload(source), ...ref } } }
      }
      if (value.type === 'tool_use' && value.input && typeof value.input === 'object') {
        const ref = this.refs.get(hash(value.input))
        if (ref) return { ...value, input: { [marker]: { hash: store.putPayload(value.input), ...ref } } }
      }
      const result: Json = {}
      for (const [key, child] of Object.entries(value)) {
        if ((key === 'text' || key === 'content') && typeof child === 'string') {
          const ref = this.refs.get(hash(child))
          // Unknown short decorations remain framing; unknown long native inputs stay in the sidecar.
          result[key] = ref || child.length > 1024 ? { [marker]: { hash: store.putPayload(child), ...ref } } : child
        } else result[key] = typeof child === 'string' ? child : replace(child)
      }
      return result
    }
    lines.forEach((line, at) => {
      const entry = JSON.parse(line)
      if (entry.type !== 'user' && !generated.has(line)) {
        entries.push(line)
        return
      }
      const before = imageAt
      if (entry.message?.content !== undefined) entry.message.content = replace(entry.message.content)
      const after = imageAt
      if (entry.toolUseResult !== undefined) {
        imageAt = before
        entry.toolUseResult = replace(entry.toolUseResult)
        imageAt = after
      }
      replay.push({ at, line: JSON.stringify(entry) })
    })
    return { entries, replay }
  }
}

export function checkReplay(replay: Json, entries: number): void {
  if (!Array.isArray(replay)) throw new RecordError('bad replay templates')
  let last = -1
  const check = (value: Json): void => {
    if (!value || typeof value !== 'object') return
    if (marker in value) {
      const r = value[marker] as Ref
      if (
        Object.keys(value).length !== 1 || !r || typeof r !== 'object' || typeof r.hash !== 'string' || !/^[0-9a-f]{64}$/.test(r.hash) ||
        (r.path !== undefined && (!Array.isArray(r.path) || r.path.length < 1 || r.path.length > 8 || r.path.some((i) => !Number.isSafeInteger(i) || i < 0))) ||
        (r.image !== undefined && r.image !== true) || (r.json !== undefined && r.json !== true) || (r.prefix !== undefined && r.prefix !== ' ')
      ) throw new RecordError('bad input reference')
      return
    }
    for (const child of Object.values(value)) check(child)
  }
  for (const r of replay) {
    if (!r || !Number.isSafeInteger(r.at) || r.at <= last || r.at >= entries + replay.length || typeof r.line !== 'string' || /[\r\n]/.test(r.line)) {
      throw new RecordError('bad replay line position')
    }
    last = r.at
    let entry: Json
    try {
      entry = JSON.parse(r.line)
    } catch {
      throw new RecordError('bad replay JSON')
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new RecordError('bad replay entry')
    check(entry)
  }
}

export function replayLog(record: ProviderRecord, store: PayloadStore, items?: InItem[]): string[] {
  const input = items?.map(canonItem).filter((v) => v !== null)
  const restore = (value: Json): Json => {
    if (Array.isArray(value)) return value.map(restore)
    if (!value || typeof value !== 'object') return value
    if (marker in value) {
      const r = value[marker] as Ref
      const cached = store.getPayload(r.hash)
      if (cached !== undefined) return cached
      if (!input || !r.path) throw new RecordError('input payload sidecar is missing and this create cannot regenerate it')
      let original: Json = input
      for (const at of r.path) original = original?.[at]
      if (r.image) {
        if (!Array.isArray(original) || original[0] !== 'i' || typeof original[1] !== 'string' || typeof original[2] !== 'string') {
          throw new RecordError('input image reference does not resolve')
        }
        original = { type: 'base64', media_type: original[1], data: original[2] }
      } else if (r.json) {
        if (typeof original !== 'string') throw new RecordError('input argument reference does not resolve')
        try {
          original = JSON.parse(original)
        } catch {
          throw new RecordError('input arguments are not JSON')
        }
        if (!original || typeof original !== 'object' || Array.isArray(original)) throw new RecordError('input arguments are not an object')
      } else {
        if (typeof original !== 'string') throw new RecordError('input text reference does not resolve')
        original = (r.prefix ?? '') + original
      }
      const actual = store.putPayload(original)
      if (actual !== r.hash) store.aliasPayload(r.hash, actual)
      return original
    }
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, restore(v)]))
  }
  return recordLogTemplates(record).map((line) => line.template ? JSON.stringify(restore(JSON.parse(line.text))) : line.text)
}

export function recordLogTemplates(record: ProviderRecord): { text: string; template: boolean }[] {
  const result: { text: string; template: boolean }[] = []
  let entry = 0, template = 0
  const replay = record.replay ?? []
  for (let at = 0; at < record.entries.length + replay.length; at++) {
    if (replay[template]?.at === at) result.push({ text: replay[template++].line, template: true })
    else result.push({ text: record.entries[entry++], template: false })
  }
  return result
}

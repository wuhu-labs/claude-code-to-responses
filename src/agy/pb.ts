// Minimal protobuf tree editor for agy's step payloads (raw bytes, no schema): parse into field lists, edit, re-encode.
// A field is {field, wt, value}; a `2`-wire field's bytes can be read as a nested message with `message()`, which only
// answers when the bytes re-encode identically (so an opaque blob never passes for a message). New fields are appended;
// existing ones are replaced in place, which is what agy's own writes look like to the model.
export type WireType = 0 | 1 | 2 | 5
export interface Field {
  field: number
  wt: WireType
  /** A varint keeps its exact value as a bigint (agy writes up to 19 digits, past a JS number's precision). */
  value: bigint | Uint8Array
}

export class ProtobufError extends Error {}

function readVarint(bytes: Uint8Array, at: number): [bigint, number] {
  let shift = 0n
  let value = 0n
  let i = at
  while (true) {
    if (i >= bytes.length) throw new ProtobufError('truncated varint')
    const byte = bytes[i++]
    value |= BigInt(byte & 0x7f) << shift
    if (!(byte & 0x80)) return [value, i]
    shift += 7n
    if (shift > 63n) throw new ProtobufError('varint too long')
  }
}

function writeVarint(out: number[], value: bigint): void {
  let v = value
  for (;;) {
    const byte = Number(v & 0x7fn)
    v >>= 7n
    if (v) out.push(byte | 0x80)
    else {
      out.push(byte)
      return
    }
  }
}

export function decode(bytes: Uint8Array): Field[] {
  const out: Field[] = []
  let i = 0
  while (i < bytes.length) {
    const [key, next] = readVarint(bytes, i)
    i = next
    const field = Number(key >> 3n)
    const wt = Number(key & 7n) as WireType
    if (field <= 0) throw new ProtobufError('bad field number')
    if (wt === 0) {
      const [value, at] = readVarint(bytes, i)
      i = at
      out.push({ field, wt, value })
    } else if (wt === 2) {
      const [size, at] = readVarint(bytes, i)
      if (size > BigInt(bytes.length)) throw new ProtobufError('truncated length-delimited field')
      const length = Number(size)
      if (at + length > bytes.length) throw new ProtobufError('truncated length-delimited field')
      out.push({ field, wt, value: bytes.subarray(at, at + length) })
      i = at + length
    } else if (wt === 1 || wt === 5) {
      const length = wt === 1 ? 8 : 4
      if (i + length > bytes.length) throw new ProtobufError('truncated fixed field')
      out.push({ field, wt, value: bytes.subarray(i, i + length) })
      i += length
    } else throw new ProtobufError(`wire type ${wt}`)
  }
  return out
}

export function encode(fields: Field[]): Uint8Array {
  const out: number[] = []
  for (const f of fields) {
    writeVarint(out, BigInt(f.field * 8 + f.wt))
    if (f.wt === 0) {
      writeVarint(out, f.value as bigint)
      continue
    }
    const bytes = f.value as Uint8Array
    // only a length-delimited field carries its length; fixed64/fixed32 are their own bytes
    if (f.wt === 2) writeVarint(out, BigInt(bytes.length))
    for (const b of bytes) out.push(b)
  }
  return new Uint8Array(out)
}

/** The nested message of a length-delimited field, or null when those bytes are not exactly one message. */
export function message(fields: Field[], field: number): Field[] | null {
  for (const f of fields) {
    if (f.field !== field || f.wt !== 2) continue
    const bytes = f.value as Uint8Array
    let tree: Field[]
    try {
      tree = decode(bytes)
      if (!tree.length || encode(tree).length !== bytes.length || !same(encode(tree), bytes)) continue
    } catch {
      continue
    }
    return tree
  }
  return null
}

function same(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

export function text(fields: Field[], field: number): string | null {
  for (const f of fields) if (f.field === field && f.wt === 2) return new TextDecoder().decode(f.value as Uint8Array)
  return null
}

export function integer(fields: Field[], field: number): number | null {
  for (const f of fields) if (f.field === field && f.wt === 0) return Number(f.value as bigint)
  return null
}

export function setText(fields: Field[], field: number, value: string): Field[] {
  return setField(fields, { field, wt: 2, value: new TextEncoder().encode(value) })
}

export function setMessage(fields: Field[], field: number, tree: Field[]): Field[] {
  return setField(fields, { field, wt: 2, value: encode(tree) })
}

export function setInteger(fields: Field[], field: number, value: number): Field[] {
  return setField(fields, { field, wt: 0, value: BigInt(value) })
}

function setField(fields: Field[], next: Field): Field[] {
  for (const f of fields) {
    if (f.field === next.field && f.wt === next.wt) {
      f.value = next.value
      return fields
    }
  }
  fields.push(next)
  return fields
}

/** A binary or string field of a nested message, as an empty list when absent. */
export function sub(fields: Field[], field: number): Field[] {
  return message(fields, field) ?? []
}

/**
 * A nested message field the way agy's rows distinguish its cases: null when the field is absent, `[]` when it is
 * present and empty (agy writes that), and a ProtobufError when it is present and is not exactly one message — an
 * opaque or corrupt block is never read as "no block" and silently rewritten.
 */
export function nested(fields: Field[], field: number): Field[] | null {
  const f = fields.find((f) => f.field === field && f.wt === 2)
  if (!f) return null
  const bytes = f.value as Uint8Array
  if (!bytes.length) return []
  const tree = decode(bytes)
  if (!tree.length || !same(encode(tree), bytes)) throw new ProtobufError(`field ${field} is not a message`)
  return tree
}

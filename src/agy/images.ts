// Image bytes in agy's step rows. agy keeps an ingested image in the step it belongs to (a user upload, or the bytes
// `read_file` returned). A provider record must never repeat bytes the client's own history already holds: those runs
// are left out of the recorded row and named by their digest; a rebuild puts them back from the client's items. Bytes
// agy produced itself (a downsized copy it stores and sends) match no client image and ride in the record.
import { createHash } from 'node:crypto'
import { Buffer } from 'node:buffer'
import type { InItem } from '../api/request.ts'
import type { StepsRowJson } from './rows.ts'

export interface StepCrop {
  /** The step row the bytes were left out of. */
  idx: number
  /** Where they go back, in the recorded payload's own bytes; adjacent crops share an offset and keep their order. */
  at: number
  length: number
  /** sha256 of the omitted bytes. */
  digest: string
}

export function imageDigest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** The bytes of every image the client's items carry, by digest. */
export function clientImages(items: InItem[]): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>()
  for (const item of items) {
    if (item.kind !== 'message' && item.kind !== 'function_call_output') continue
    for (const part of item.parts) {
      if (part.type !== 'image') continue
      const bytes = new Uint8Array(Buffer.from(part.data, 'base64'))
      out.set(imageDigest(bytes), bytes)
    }
  }
  return out
}

/** The row with every run of a client image's bytes left out, and the crops that put them back. */
export function cropStepImages(row: StepsRowJson, images: Map<string, Uint8Array>): { row: StepsRowJson; crops: StepCrop[] } {
  if (!row.step_payload || !images.size) return { row, crops: [] }
  const payload = Buffer.from(row.step_payload, 'base64')
  const runs = imageRuns(payload, images)
  if (!runs.length) return { row, crops: [] }
  const kept: Buffer[] = []
  const crops: StepCrop[] = []
  let from = 0, removed = 0
  for (const run of runs) {
    kept.push(payload.subarray(from, run.at))
    crops.push({ idx: row.idx, at: run.at - removed, length: run.length, digest: run.digest })
    removed += run.length
    from = run.at + run.length
  }
  kept.push(payload.subarray(from))
  return { row: { ...row, step_payload: Buffer.concat(kept).toString('base64') }, crops }
}

/** The row with the client's bytes put back; `missing` names the digests this request's items do not carry. */
export function restoreStepImages(
  row: StepsRowJson,
  crops: StepCrop[],
  images: Map<string, Uint8Array>,
): { row: StepsRowJson; missing: string[] } {
  if (!crops.length) return { row, missing: [] }
  let payload = Buffer.from(row.step_payload ?? '', 'base64')
  const missing = new Set<string>()
  for (let i = crops.length - 1; i >= 0; i--) {
    const crop = crops[i]
    const bytes = images.get(crop.digest)
    if (!bytes) {
      missing.add(crop.digest)
      continue
    }
    payload = Buffer.concat([payload.subarray(0, crop.at), Buffer.from(bytes), payload.subarray(crop.at)])
  }
  return { row: missing.size ? row : { ...row, step_payload: payload.toString('base64') }, missing: [...missing] }
}

/** Every non-overlapping run of a client image's bytes in a payload, in payload order. */
function imageRuns(payload: Buffer, images: Map<string, Uint8Array>): { at: number; length: number; digest: string }[] {
  const runs: { at: number; length: number; digest: string }[] = []
  let at = 0
  while (at < payload.length) {
    let best: { at: number; length: number; digest: string } | null = null
    for (const [digest, bytes] of images) {
      const found = payload.indexOf(Buffer.from(bytes), at)
      if (found < 0) continue
      if (!best || found < best.at || (found === best.at && bytes.length > best.length)) best = { at: found, length: bytes.length, digest }
    }
    if (!best) break
    runs.push(best)
    at = best.at + best.length
  }
  return runs
}

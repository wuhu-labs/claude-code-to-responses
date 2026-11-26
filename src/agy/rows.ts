// agy's `steps` rows as a provider record carries them, and the store's two chain-wide rows.
// A record holds every row that changed since the parent response (a new step, or a tool step the gateway completed),
// plus `trajectory_meta` and `trajectory_metadata_blob` on the chain's first response. `gen_metadata` and
// `executor_metadata` are never recorded: resume does not need them and their prompt copy is not reproducible.
import type { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { STEPS_COLUMNS, TRAJECTORY_BLOB_COLUMNS, TRAJECTORY_META_COLUMNS } from './schema.ts'

export interface StepsRow {
  idx: number
  step_type: number
  status: number
  has_subtrajectory: number
  metadata: Uint8Array | null
  error_details: Uint8Array | null
  permissions: Uint8Array | null
  task_details: Uint8Array | null
  render_info: Uint8Array | null
  step_payload: Uint8Array | null
  step_format: number
}

export interface TrajectoryMetaRow {
  trajectory_id: string
  cascade_id: string
  trajectory_type: number | null
  source: number | null
}

export interface TrajectoryBlobRow {
  id: string
  data: Uint8Array
}

export interface Trajectory {
  meta: TrajectoryMetaRow
  blob: TrajectoryBlobRow | null
}

type Json = number | string | null
export interface StepsRowJson extends Record<string, Json> {
  idx: number
  step_type: number
  status: number
  has_subtrajectory: number
  metadata: string | null
  error_details: string | null
  permissions: string | null
  task_details: string | null
  render_info: string | null
  step_payload: string | null
  step_format: number
}

export interface TrajectoryJson {
  meta: TrajectoryMetaRow
  blob: { id: string; data: string } | null
}

const BLOBS = ['metadata', 'error_details', 'permissions', 'task_details', 'render_info', 'step_payload'] as const

function base64(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}

function unbase64(text: string): Uint8Array {
  const binary = atob(text)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

export function stepsRowJson(row: StepsRow): StepsRowJson {
  const out: Record<string, number | string | null> = {}
  for (const column of STEPS_COLUMNS) {
    const value = row[column]
    out[column] = value instanceof Uint8Array ? base64(value) : value
  }
  return out as StepsRowJson
}

export function stepsRowFromJson(row: StepsRowJson): StepsRow {
  const out = { ...row } as unknown as StepsRow
  for (const column of BLOBS) {
    const value = row[column]
    if (value !== null && typeof value === 'string') out[column] = unbase64(value)
  }
  return out
}

/** Identity and content of a row: two rows with the same key and hash are the same row. */
export function stepsKey(row: StepsRowJson): string {
  return String(row.idx)
}

export function stepsHash(row: StepsRowJson): string {
  return createHash('sha256').update(JSON.stringify(STEPS_COLUMNS.map((column) => row[column]))).digest('hex')
}

export function readSteps(db: DatabaseSync): StepsRow[] {
  return db.prepare(`select ${STEPS_COLUMNS.join(',')} from steps order by idx`).all() as unknown as StepsRow[]
}

export function readTrajectory(db: DatabaseSync): Trajectory | null {
  const meta = db.prepare(`select ${TRAJECTORY_META_COLUMNS.join(',')} from trajectory_meta`).get() as TrajectoryMetaRow | undefined
  if (!meta) return null
  const blob = db.prepare(`select ${TRAJECTORY_BLOB_COLUMNS.join(',')} from trajectory_metadata_blob`).get() as TrajectoryBlobRow | undefined
  return { meta: { ...meta }, blob: blob ? { id: blob.id, data: blob.data } : null }
}

export function writeSteps(db: DatabaseSync, rows: StepsRow[]): void {
  const insert = db.prepare(`insert into steps (${STEPS_COLUMNS.join(',')}) values (${STEPS_COLUMNS.map(() => '?').join(',')})`)
  for (const row of rows) insert.run(...STEPS_COLUMNS.map((column) => row[column] as never))
}

export function writeTrajectory(db: DatabaseSync, trajectory: Trajectory): void {
  db.prepare(`insert into trajectory_meta (${TRAJECTORY_META_COLUMNS.join(',')}) values (?,?,?,?)`)
    .run(trajectory.meta.trajectory_id, trajectory.meta.cascade_id, trajectory.meta.trajectory_type, trajectory.meta.source)
  if (trajectory.blob) db.prepare('insert into trajectory_metadata_blob (id,data) values (?,?)').run(trajectory.blob.id, trajectory.blob.data)
}

export function trajectoryJson(trajectory: Trajectory): TrajectoryJson {
  return {
    meta: { ...trajectory.meta },
    blob: trajectory.blob ? { id: trajectory.blob.id, data: base64(trajectory.blob.data) } : null,
  }
}

export function trajectoryFromJson(json: TrajectoryJson): Trajectory {
  return { meta: { ...json.meta }, blob: json.blob ? { id: json.blob.id, data: unbase64(json.blob.data) } : null }
}

// The conversation store agy 1.5.17 writes: schema, pragmas and table order. A rebuilt store is only accepted by agy
// with every table present (the four the gateway leaves empty included), these pragmas and this user_version.
// Measured on 1.5.17 (`conversations/<id>.db`, DDL read from a real store); the version pin in config/gateway refuses
// any other agy, so this is the only layout the gateway assembles or patches.
import { DatabaseSync } from 'node:sqlite'

export const AGY_VERSION = '1.5.17'
export const USER_VERSION = 1
export const PAGE_SIZE = 32768

export const DDL = [
  'CREATE TABLE `trajectory_meta` (`trajectory_id` text,`cascade_id` text,`trajectory_type` integer,`source` integer,PRIMARY KEY (`trajectory_id`))',
  'CREATE TABLE `trajectory_metadata_blob` (`id` text DEFAULT "main",`data` blob,PRIMARY KEY (`id`))',
  'CREATE TABLE `steps` (`idx` integer,`step_type` integer NOT NULL DEFAULT 0,`status` integer NOT NULL DEFAULT 0,`has_subtrajectory` numeric NOT NULL DEFAULT false,`metadata` blob,`error_details` blob,`permissions` blob,`task_details` blob,`render_info` blob,`step_payload` blob,`step_format` integer NOT NULL DEFAULT 0,PRIMARY KEY (`idx`))',
  'CREATE TABLE `gen_metadata` (`idx` integer,`data` blob,`size` integer NOT NULL DEFAULT 0,PRIMARY KEY (`idx`))',
  'CREATE TABLE `executor_metadata` (`idx` integer,`data` blob,PRIMARY KEY (`idx`))',
  'CREATE TABLE `parent_references` (`idx` integer,`data` blob,PRIMARY KEY (`idx`))',
  'CREATE TABLE `battle_mode_infos` (`idx` integer,`data` blob,PRIMARY KEY (`idx`))',
  'CREATE INDEX `idx_steps_status` ON `steps`(`status`)',
  'CREATE INDEX `idx_steps_step_type` ON `steps`(`step_type`)',
]

/** Table order of the source DDL; a rebuild inserts in it. */
export const TABLES = ['trajectory_meta', 'trajectory_metadata_blob', 'steps', 'gen_metadata', 'executor_metadata', 'parent_references', 'battle_mode_infos'] as const
export type Table = typeof TABLES[number]

export const STEPS_COLUMNS = [
  'idx',
  'step_type',
  'status',
  'has_subtrajectory',
  'metadata',
  'error_details',
  'permissions',
  'task_details',
  'render_info',
  'step_payload',
  'step_format',
] as const

export const TRAJECTORY_META_COLUMNS = ['trajectory_id', 'cascade_id', 'trajectory_type', 'source'] as const
export const TRAJECTORY_BLOB_COLUMNS = ['id', 'data'] as const

export type SchemaError = { table: string; actual: string[]; expected: readonly string[] }

/** The source store's layout, or what differs from the pinned one. */
export function layoutProblem(db: DatabaseSync): string | null {
  const version = db.prepare('PRAGMA user_version').get() as Record<string, unknown> | undefined
  if (Number(Object.values(version ?? {})[0]) !== USER_VERSION) return `user_version is not ${USER_VERSION}`
  const names = new Set((db.prepare("select name from sqlite_master where type = 'table' and name not like 'sqlite_%'").all() as { name: string }[]).map((r) => r.name))
  for (const table of TABLES) if (!names.has(table)) return `table ${table} is missing`
  const columns = (table: string) => (db.prepare(`PRAGMA table_info('${table}')`).all() as { name: string }[]).map((c) => c.name)
  const steps = columns('steps')
  if (steps.join(',') !== STEPS_COLUMNS.join(',')) return `steps columns are ${steps.join(',')}`
  const meta = columns('trajectory_meta')
  if (meta.join(',') !== TRAJECTORY_META_COLUMNS.join(',')) return `trajectory_meta columns are ${meta.join(',')}`
  const blob = columns('trajectory_metadata_blob')
  if (blob.join(',') !== TRAJECTORY_BLOB_COLUMNS.join(',')) return `trajectory_metadata_blob columns are ${blob.join(',')}`
  return null
}

/** A fresh store with agy's schema and pragmas, every table empty. */
export function createStore(path: string): DatabaseSync {
  const db = new DatabaseSync(path)
  db.exec(`PRAGMA page_size=${PAGE_SIZE}`)
  db.exec('PRAGMA journal_mode=WAL')
  db.exec(`PRAGMA user_version=${USER_VERSION}`)
  for (const statement of DDL) db.exec(statement)
  return db
}

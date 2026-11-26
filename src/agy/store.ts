// agy's conversation store as a cache: the one gemini dir from the gateway's configuration, one workspace per chain,
// and the per-conversation db + brain folder. The gateway reads rows from a live store, rewrites a conversation from
// its records, and never treats either as the truth: the provider records are the state.
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { createStore, layoutProblem } from './schema.ts'
import { readSteps, readTrajectory, type StepsRow, type Trajectory, writeSteps, writeTrajectory } from './rows.ts'

export class StoreError extends Error {}

/** Writes a JSON file atomically (owner-only), agy's own config included. */
export function put(path: string, value: unknown): void {
  Deno.writeTextFileSync(`${path}.tmp`, JSON.stringify(value), { mode: 0o600 })
  Deno.renameSync(`${path}.tmp`, path)
}

export interface Snapshot {
  steps: StepsRow[]
  trajectory: Trajectory | null
}

export class Store {
  constructor(readonly root: string) {
    for (const name of ['workspaces', 'responses']) Deno.mkdirSync(`${root}/${name}`, { recursive: true, mode: 0o700 })
  }

  /** The one agy state folder every chain runs in, fixed by configuration (its sign-in lives here). */
  get gemini(): string {
    return `${this.root}/gemini`
  }

  /** The chains with a workspace: what a crashed gateway may have left a process for. */
  chains(): Set<string> {
    return new Set(Array.from(Deno.readDirSync(`${this.root}/workspaces`)).filter((f) => f.isDirectory).map((f) => f.name))
  }

  /** A chain's working folder: its prompt names it, so its path is determined by the configured root and the chain. */
  workspace(chain: string): string {
    return `${this.root}/workspaces/${chain}`
  }

  private conversations(): string {
    return `${this.gemini}/antigravity-cli/conversations`
  }

  dbPath(conversation: string): string {
    return `${this.conversations()}/${conversation}.db`
  }

  brainDir(conversation: string): string {
    return `${this.gemini}/antigravity-cli/brain/${conversation}`
  }

  /** A step's output file: the path the preview notice and the step's `file://` field name. */
  outputFile(conversation: string, idx: number): { url: string; path: string } {
    const path = join(this.brainDir(conversation), '.system_generated', 'steps', String(idx), 'output.txt')
    return { url: `file://${path}`, path }
  }

  /**
   * The rows of a live conversation. A read-only connection reads through the WAL without checkpointing it, so a
   * running agy never sees its store touched. Null when the conversation has no db (agy has not written it).
   */
  snapshot(conversation: string): Snapshot | null {
    const path = this.dbPath(conversation)
    let db: DatabaseSync
    try {
      db = new DatabaseSync(path, { readOnly: true })
    } catch (e) {
      if (e instanceof Deno.errors.NotFound || String(e).includes('unable to open')) return null
      throw e
    }
    try {
      const problem = layoutProblem(db)
      if (problem) throw new StoreError(`conversation ${conversation} does not have agy 1.5.17's layout: ${problem}`)
      return { steps: readSteps(db), trajectory: readTrajectory(db) }
    } finally {
      db.close()
    }
  }

  /** Replaces a conversation with a store assembled from these rows: agy's schema, the two populated tables, no brain. */
  assemble(conversation: string, snapshot: Snapshot): void {
    Deno.mkdirSync(this.conversations(), { recursive: true, mode: 0o700 })
    this.remove(conversation)
    const db = createStore(this.dbPath(conversation))
    try {
      writeSteps(db, snapshot.steps)
      if (snapshot.trajectory) writeTrajectory(db, snapshot.trajectory)
    } finally {
      db.close()
    }
  }

  /** Removes a conversation's db (and its WAL/SHM) and its brain folder, so nothing stale survives a rebuild. */
  remove(conversation: string): void {
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        Deno.removeSync(`${this.dbPath(conversation)}${suffix}`)
      } catch (e) {
        if (!(e instanceof Deno.errors.NotFound)) throw e
      }
    }
    try {
      Deno.removeSync(this.brainDir(conversation), { recursive: true })
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e
    }
  }
}

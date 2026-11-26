// The agy lane's provider record: agy's own `steps` rows for a response (plus the two chain-wide rows on the head),
// carried in a reasoning item's encrypted_content exactly as the Claude lane carries its log entries. The store these
// rows assemble is a cache; these records are the state.
import type { FnTool } from '../api/request.ts'
import type { CallAliases } from '../call_ids.ts'
import { checkCallAliases, packRecord, RECORD_PREFIX, registerRecordPrefix, RESPONSE_ID, unpackRecord } from '../records.ts'
import type { StepsRowJson, TrajectoryJson } from './rows.ts'

export const AGY_RECORD_PREFIX = 'agy2r.record.v1.'
registerRecordPrefix(AGY_RECORD_PREFIX)

export interface CallRef {
  /** agy's own call id inside the step payload; the client's ids are bound to these in `callAliases`. */
  id: string
  /** The client's tool name, without the MCP prefix. */
  name: string
  /** The step that holds this call's result. */
  step: number
}

export interface AgyRecord {
  v: 1
  id: string
  prev: string | null
  /** The chain: one workspace, one agy process at a time, one provider conversation. */
  chain: string
  /** The chain head: the instructions its agent file holds. */
  instructions?: string
  /** The chain head: the model selection every launch sets. */
  model?: string
  /** The chain head: the tools its agent declares and its prompt names. */
  tools?: FnTool[]
  /** agy's conversation id: the store file's name and every step payload's own id. */
  conversation: string
  /** The chain head: the gemini dir and the working folder the chain ran with (both are in agy's prompt). */
  gemini?: string
  workspace?: string
  end: 'turn' | 'calls'
  calls: CallRef[]
  /** The clients' call ids bound to agy's, accumulated over the chain; every pair is one-to-one. */
  callAliases?: CallAliases
  digest: string
  jsonArgumentDigest?: string
  /** The agy version whose store layout these rows belong to; another version's store is refused, never patched. */
  agy: string
  steps: StepsRowJson[]
  trajectory?: TrajectoryJson
}

const CHAIN = /^[A-Za-z0-9_-]{1,128}$/
const CONVERSATION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const HEX64 = /^[0-9a-f]{64}$/
const CALL_ID = /^[A-Za-z0-9_-]{1,128}$/
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/

export async function encodeAgyRecord(record: AgyRecord): Promise<string> {
  return packRecord(AGY_RECORD_PREFIX, record)
}

/** Why a reasoning item is not a usable record of the running lane: malformed, or from another lane or version. */
export class RecordVerdict extends Error {
  constructor(readonly kind: 'malformed' | 'foreign', message: string) {
    super(message)
  }
}

/**
 * The one reader of a provider record, wherever it comes from: null when the content is not a record at all, the
 * record when it is one of this lane's at the running binary's version, and a RecordVerdict naming why it is not.
 */
export async function readAgyRecord(content: string, version: string): Promise<AgyRecord | null> {
  if (content.startsWith(RECORD_PREFIX)) throw new RecordVerdict('foreign', "the Claude lane's provider record")
  if (!content.startsWith(AGY_RECORD_PREFIX)) return null
  let record: unknown
  try {
    record = await unpackRecord(AGY_RECORD_PREFIX, content)
  } catch (e) {
    throw new RecordVerdict('malformed', `not a valid provider record (${(e as Error).message})`)
  }
  return checkAgyRecord(record, version)
}

/** Validates a record against the running binary's version; also the reader of every record the gateway stored. */
export function checkAgyRecord(r: unknown, version: string): AgyRecord {
  const fail = (why: string) => {
    throw new RecordVerdict('malformed', why)
  }
  if (typeof r !== 'object' || r === null) fail('not an object')
  const record = r as Record<string, unknown>
  if (record.v !== 1) fail('unknown version')
  if (typeof record.id !== 'string' || !RESPONSE_ID.test(record.id)) fail('bad id')
  if (record.prev !== null && (typeof record.prev !== 'string' || !RESPONSE_ID.test(record.prev))) fail('bad prev')
  if (typeof record.chain !== 'string' || !CHAIN.test(record.chain)) fail('bad chain')
  if (record.instructions !== undefined && (typeof record.instructions !== 'string' || !record.instructions)) fail('bad instructions')
  if (record.model !== undefined && (typeof record.model !== 'string' || !record.model)) fail('bad model')
  if (record.tools !== undefined && !Array.isArray(record.tools)) fail('bad tools')
  if (typeof record.conversation !== 'string' || !CONVERSATION.test(record.conversation)) fail('bad conversation')
  if (record.end !== 'turn' && record.end !== 'calls') fail('bad end')
  if (!Array.isArray(record.calls) || (record.end === 'turn') !== (record.calls.length === 0)) fail('bad calls')
  for (const call of record.calls as Record<string, unknown>[]) {
    if (typeof call !== 'object' || call === null) fail('bad call')
    if (typeof call.id !== 'string' || !CALL_ID.test(call.id)) fail('bad call id')
    if (typeof call.name !== 'string' || !TOOL_NAME.test(call.name)) fail('bad call name')
    if (!Number.isSafeInteger(call.step) || (call.step as number) < 0) fail('bad call step')
  }
  checkCallAliases(record.callAliases)
  if (typeof record.digest !== 'string' || !HEX64.test(record.digest)) fail('bad digest')
  if (record.jsonArgumentDigest !== undefined && (typeof record.jsonArgumentDigest !== 'string' || !HEX64.test(record.jsonArgumentDigest))) {
    fail('bad JSON argument digest')
  }
  if (typeof record.agy !== 'string' || !/^\d+\.\d+\.\d+/.test(record.agy)) fail('bad agy version')
  if (record.agy !== version) throw new RecordVerdict('foreign', `a record from agy ${record.agy}, not ${version}`)
  if (record.gemini !== undefined && (typeof record.gemini !== 'string' || !record.gemini.startsWith('/'))) fail('bad gemini dir')
  if (record.workspace !== undefined && (typeof record.workspace !== 'string' || !record.workspace.startsWith('/'))) fail('bad workspace')
  if (!Array.isArray(record.steps) || !record.steps.length) fail('bad steps')
  let previous = -1
  for (const step of record.steps as Record<string, unknown>[]) {
    if (typeof step !== 'object' || step === null) fail('bad step')
    if (!Number.isSafeInteger(step.idx) || (step.idx as number) <= previous) fail('bad step index')
    previous = step.idx as number
    if (!Number.isSafeInteger(step.step_type) || !Number.isSafeInteger(step.status)) fail('bad step type or status')
    for (const column of ['metadata', 'error_details', 'permissions', 'task_details', 'render_info', 'step_payload']) {
      const value = step[column]
      if (value === null) continue
      if (typeof value !== 'string' || !BASE64.test(value)) fail(`bad step ${column}`)
      try {
        atob(value as string)
      } catch {
        fail(`bad step ${column}`)
      }
    }
  }
  if (record.trajectory !== undefined) {
    const trajectory = record.trajectory as Record<string, unknown>
    const meta = trajectory?.meta as Record<string, unknown> | undefined
    if (typeof meta !== 'object' || meta === null) fail('bad trajectory metadata')
    const { trajectory_id: trajectoryId, cascade_id: cascadeId } = meta as Record<string, unknown>
    if (typeof trajectoryId !== 'string' || !CONVERSATION.test(trajectoryId)) fail('bad trajectory id')
    if (typeof cascadeId !== 'string' || !CONVERSATION.test(cascadeId)) fail('bad cascade id')
    const blob = trajectory.blob as Record<string, unknown> | null
    if (blob !== null) {
      if (typeof blob !== 'object' || typeof blob.data !== 'string' || !BASE64.test(blob.data)) fail('bad trajectory blob')
      try {
        atob(blob.data as string)
      } catch {
        fail('bad trajectory blob')
      }
    }
  }
  return record as unknown as AgyRecord
}

// Allowlisted metadata only: never retain raw model blocks, argument values, text, or error messages here.
import { createHash } from 'node:crypto'
import { GatewayError } from './errors.ts'

export const MALFORMED_REASONS = [
  'id_missing',
  'id_type',
  'id_length',
  'id_charset',
  'name_missing',
  'name_type',
  'name_length',
  'name_charset',
  'input_missing',
  'input_not_object',
  'arguments_invalid_json',
  'arguments_not_object',
  'tool_use_without_tool',
] as const
export type MalformedReason = typeof MALFORMED_REASONS[number]
export type FailedField = 'id' | 'name' | 'input' | 'arguments' | 'stop_reason'

export interface Shape {
  type: 'missing' | 'null' | 'array' | 'object' | 'string' | 'number' | 'boolean'
  /** UTF-16 code units for strings, elements for arrays; null for other JSON types. */
  length: number | null
  key_count: number | null
}

export function shape(value: unknown): Shape {
  if (value === undefined) return { type: 'missing', length: null, key_count: null }
  if (value === null) return { type: 'null', length: null, key_count: null }
  if (Array.isArray(value)) return { type: 'array', length: value.length, key_count: null }
  if (typeof value === 'object') return { type: 'object', length: null, key_count: Object.keys(value).length }
  if (typeof value === 'string') return { type: 'string', length: value.length, key_count: null }
  return { type: typeof value as 'number' | 'boolean', length: null, key_count: null }
}

export interface ToolSummary {
  type: Shape['type']
  length: number | null
  name?: string
  hash?: string
}

export function toolSummary(name: unknown): ToolSummary {
  const { type, length } = shape(name)
  if (typeof name !== 'string') return { type, length }
  // Even charset-valid overlong names stay bounded. The hash is of the UTF-8 string, never its arguments.
  return /^[A-Za-z0-9_-]{1,64}$/.test(name) ? { type, length, name } : { type, length, hash: createHash('sha256').update(name).digest('hex').slice(0, 16) }
}

export interface MalformedDetails {
  block_index: number | null
  failed_field: FailedField
  field: Shape
  tool: ToolSummary | null
  input: Shape | null
}

export class MalformedModelError extends GatewayError {
  constructor(readonly reason: MalformedReason, readonly details: MalformedDetails) {
    const message = details.failed_field === 'arguments'
      ? 'The model sent tool_use arguments that are not a JSON object.'
      : details.failed_field === 'stop_reason'
      ? 'The model stopped for tool use without calling a tool.'
      : 'The model sent a malformed tool_use block.'
    super(500, 'server_error', 'malformed_model_message', message, null, { extra: { reason } })
  }
}

function blockIndex(index: unknown): number | null {
  return typeof index === 'number' && Number.isSafeInteger(index) && index >= 0 ? index : null
}

function malformed(reason: MalformedReason, field: FailedField, value: unknown, index: unknown, name: unknown, input: unknown): MalformedModelError {
  return new MalformedModelError(reason, {
    block_index: blockIndex(index),
    failed_field: field,
    field: shape(value),
    tool: toolSummary(name),
    input: shape(input),
  })
}

/** Same accepted set as the original combined regex/object check, with deterministic first-failed-field reasons. */
export function toolHeaderError(cb: { id?: unknown; name?: unknown; input?: unknown }, index: unknown): MalformedModelError | null {
  for (const field of ['id', 'name'] as const) {
    const value = cb[field]
    const error = (reason: MalformedReason) => malformed(reason, field, value, index, cb.name, cb.input)
    if (value === undefined) return error(`${field}_missing`)
    if (typeof value !== 'string') return error(`${field}_type`)
    if (value.length < 1 || value.length > (field === 'id' ? 128 : 64)) return error(`${field}_length`)
    if (!/^[A-Za-z0-9_-]+$/.test(value)) return error(`${field}_charset`)
  }
  if (cb.input === undefined) return malformed('input_missing', 'input', cb.input, index, cb.name, cb.input)
  if (cb.input === null || typeof cb.input !== 'object' || Array.isArray(cb.input)) {
    return malformed('input_not_object', 'input', cb.input, index, cb.name, cb.input)
  }
  return null
}

/** Empty/whitespace argument streams still mean {}. Invalid JSON and valid non-object JSON remain distinct. */
export function toolArgumentsError(buf: string, index: unknown, tool: ToolSummary): MalformedModelError | null {
  let input: unknown
  let reason: MalformedReason | null = null
  try {
    input = JSON.parse(buf.trim() ? buf : '{}')
    if (input === null || typeof input !== 'object' || Array.isArray(input)) reason = 'arguments_not_object'
  } catch {
    reason = 'arguments_invalid_json'
  }
  return reason === null ? null : new MalformedModelError(reason, {
    block_index: blockIndex(index),
    failed_field: 'arguments',
    field: shape(buf),
    tool,
    input: shape(input),
  })
}

export function toolStopError(): MalformedModelError {
  return new MalformedModelError('tool_use_without_tool', {
    block_index: null,
    failed_field: 'stop_reason',
    field: shape('tool_use'),
    tool: null,
    input: null,
  })
}

export interface FailureDiagnostic {
  time: string
  response_id: string
  previous_response_id: string | null
  claude_session_id: string
  message_id: string | null
  code: GatewayError['code']
  reason: MalformedReason | null
  block_index: number | null
  failed_field: FailedField | null
  field: Shape | null
  tool: ToolSummary | null
  input: Shape | null
}

/** Model-supplied message ids are metadata only if bounded and identifier-shaped, never arbitrary text. */
export function diagnosticMessageId(id: unknown): string | null {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : null
}

export const FAILURE_LOG_MAX_BYTES = 1024 * 1024

/** Synchronous write + fsync: the record is durable before fail() can emit its terminal or kill the child. */
export class FailureLog {
  readonly path: string
  constructor(stateDir: string) {
    this.path = `${stateDir}/failures.jsonl`
  }

  append(record: FailureDiagnostic): void {
    const line = new TextEncoder().encode(JSON.stringify(record) + '\n')
    let size = this.completeSize()
    if (size + line.length > FAILURE_LOG_MAX_BYTES) {
      Deno.renameSync(this.path, `${this.path}.1`)
      size = 0
    }
    const file = Deno.openSync(this.path, { create: true, append: true, mode: 0o600 })
    try {
      let written = 0
      while (written < line.length) written += file.writeSync(line.subarray(written))
      file.syncSync()
    } catch (error) {
      // A short write followed by ENOSPC must not poison the next JSONL record. Keep the original failure
      // visible even if rollback itself fails; completeSize() repairs any unterminated suffix next time.
      try {
        file.truncateSync(size)
        file.syncSync()
      } catch { /* storage is still broken; the next append repairs its boundary before writing */ }
      throw error
    } finally {
      file.close()
    }
    // Persist the new file/rotation directory entries too (on the gateway's supported Linux/macOS hosts).
    const dir = Deno.openSync(this.path.replace(/\/[^/]+$/, ''), { read: true })
    try {
      dir.syncSync()
    } finally {
      dir.close()
    }
  }

  /** Retain complete records after interrupted writes/crashes, using a bounded backwards scan. */
  private completeSize(): number {
    let file: Deno.FsFile
    try {
      file = Deno.openSync(this.path, { read: true, write: true })
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return 0
      throw error
    }
    try {
      const size = file.statSync().size
      let end = size
      while (end > 0) {
        const start = Math.max(0, end - 4096)
        const chunk = new Uint8Array(end - start)
        file.seekSync(start, Deno.SeekMode.Start)
        let read = 0
        while (read < chunk.length) {
          const count = file.readSync(chunk.subarray(read))
          if (!count) throw new Error('failure diagnostics changed while recovering an incomplete record')
          read += count
        }
        const newline = chunk.lastIndexOf(10)
        if (newline >= 0) {
          const complete = start + newline + 1
          if (complete < size) {
            file.truncateSync(complete)
            file.syncSync()
          }
          return complete
        }
        end = start
      }
      if (size > 0) {
        file.truncateSync(0)
        file.syncSync()
      }
      return 0
    } finally {
      file.close()
    }
  }
}

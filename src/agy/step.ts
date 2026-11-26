// The one place a tool result is written into an agy step, the way agy writes a native one: the row status, the
// completion timestamp, the output text with agy's `Created At` / `Completed At` header, "Executed", the rendered
// markdown and the `file://` output.txt (with the preview rule for large outputs). Queued steps (a second call of one
// planner line agy had not started) lack the tool identity and render blocks; they are built from the measured shape.
import { decode, encode, type Field, integer, message, setInteger, setMessage, setText, sub, text } from './pb.ts'
import type { StepsRow } from './rows.ts'

/** agy 1.5.17 stores an output whole up to this many bytes of `output.txt`; above it, a 10,240-byte middle preview. */
export const MAX_STORED_OUTPUT_BYTES = 10_240

/** The preview size agy cuts to (bytes, the whole `output.txt` header included). */
const PREVIEW_BYTES = 10_240

export class StepLayoutError extends Error {}

export interface StepOutput {
  /** The tool's output text as the client sent it, without agy's header. */
  text: string
  /** The step's start (its `Created At`), else its execution start, else now. */
  created: Date
  completed: Date
  /** `file://…/brain/<conversation>/.system_generated/steps/<idx>/output.txt` */
  outputUrl: string
}

/** `YYYY-MM-DDTHH:MM:SS+08:00`, agy's own stamp shape in the machine's own zone. */
export function stamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const offset = -date.getTimezoneOffset()
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${
    offset < 0 ? '-' : '+'
  }${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`
}

/** `output.txt`'s content: agy's two header lines, then the output text. */
export function outputFileText(output: StepOutput): Uint8Array {
  return new TextEncoder().encode(`Created At: ${stamp(output.created)}\nCompleted At: ${stamp(output.completed)}\n${output.text}`)
}

/**
 * What agy puts in the step (and so in the upstream functionResponse) when the output is too long to store whole:
 * a notice naming the file, then the head and the tail of the full text with one line saying what is missing.
 * The halves are byte budgets rounded to whole UTF-8 characters, so a multibyte output never yields half a character
 * and the stored text stays the size agy's own cut produces. Sizes are bytes; `M` is the `output.txt` length.
 */
export function preview(full: Uint8Array, outputUrl: string): string {
  const notice = `The tool's output was truncated due to being too long. You can find the full output in a file at ${outputUrl}.\n\nHere is a preview with the middle of the output truncated:\n`
  const encoder = new TextEncoder()
  const room = PREVIEW_BYTES - encoder.encode(notice).length
  const total = full.length
  const middle = (missing: number) => `\n<truncated ${missing} of ${total} bytes from the middle of the output>\n`
  let head = 0
  let tail = 0
  for (let i = 0; i < 8; i++) {
    const half = Math.max(0, Math.floor((room - encoder.encode(middle(total - head - tail)).length) / 2))
    // a byte budget is rounded to a character boundary: the head back, the tail forward
    const nextHead = wholePrefix(full, Math.min(half, total))
    const nextTail = Math.min(total - nextHead, wholeSuffix(full, Math.min(half, total - nextHead)))
    if (nextHead === head && nextTail === tail) break
    head = nextHead
    tail = nextTail
  }
  const decoder = new TextDecoder()
  return notice + decoder.decode(full.subarray(0, head)) + middle(total - head - tail) + decoder.decode(full.subarray(total - tail))
}

/** The longest prefix of at most `bytes` bytes that ends on a UTF-8 character boundary. */
function wholePrefix(bytes: Uint8Array, budget: number): number {
  let end = budget
  while (end > 0 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--
  return end
}

/** The longest suffix of at most `bytes` bytes that starts on a UTF-8 character boundary. */
function wholeSuffix(bytes: Uint8Array, budget: number): number {
  let start = bytes.length - budget
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++
  return bytes.length - start
}

/** The `140.2.1` value (and the `**Result**` body) for an output: whole when it fits, else the preview. */
export function storedOutput(output: StepOutput): string {
  const file = outputFileText(output)
  return file.length > MAX_STORED_OUTPUT_BYTES ? preview(file, output.outputUrl) : new TextDecoder().decode(file)
}

/** The tool call a step holds: agy's own call id, the tool without its MCP prefix, and the step's conversation. */
export function callOf(row: StepsRow): { provider: string; tool: string; conversation: string } | null {
  if (row.step_type !== 132 || !row.step_payload) return null
  let payload: Field[]
  try {
    payload = decode(row.step_payload)
  } catch {
    return null
  }
  const step5 = message(payload, 5)
  const call = step5 ? message(step5, 4) : null
  const provider = call ? text(call, 1) : null
  const name = call ? text(call, 2) : null
  const conversation = step5 ? text(sub(step5, 20), 4) : null
  if (!provider || !name || !name.startsWith('mcp_') || !conversation) return null
  const at = name.indexOf('_', 4)
  return at < 0 ? null : { provider, tool: name.slice(at + 1), conversation }
}

/** The moment agy started the step: its execution start, else its enqueue time. */
export function stepStart(row: StepsRow): Date | null {
  if (!row.step_payload) return null
  let payload: Field[]
  try {
    payload = decode(row.step_payload)
  } catch {
    return null
  }
  const step5 = message(payload, 5)
  if (!step5) return null
  for (const field of [6, 7, 1]) {
    const stamp = message(step5, field)
    const seconds = stamp ? integer(stamp, 1) : null
    if (seconds === null) continue
    const nanos = stamp ? integer(stamp, 2) ?? 0 : 0
    return new Date(seconds * 1000 + Math.floor(nanos / 1e6))
  }
  return null
}

/** Writes the result into a pending (status 2) or queued (status 1) tool-call step; returns the row as it will be stored. */
export function completeStep(row: StepsRow, output: StepOutput): StepsRow {
  if (row.step_type !== 132 || (row.status !== 1 && row.status !== 2)) {
    throw new StepLayoutError(`step ${row.idx} is not a pending tool call (type ${row.step_type}, status ${row.status})`)
  }
  if (!row.step_payload) throw new StepLayoutError(`step ${row.idx} has no payload`)
  let payload: Field[]
  try {
    payload = decode(row.step_payload)
  } catch {
    throw new StepLayoutError(`step ${row.idx}'s payload is not a message`)
  }
  const status = integer(payload, 4)
  if (status !== row.status) throw new StepLayoutError(`step ${row.idx} carries status ${status} in a row of status ${row.status}`)
  const step5 = message(payload, 5)
  if (!step5) throw new StepLayoutError(`step ${row.idx} has no step metadata`)
  const call = message(step5, 4)
  if (!call) throw new StepLayoutError(`step ${row.idx} names no tool call`)
  // The step must be exactly the tool-call layout that was measured: a pending step (status 2) carries its tool
  // identity (133), render metadata (147) and an Executing render block; a queued step (status 1) only its arguments.
  const identity = message(payload, 133)
  const renderInfo = message(payload, 147)
  const existing = sub(payload, 140)
  const executing = message(sub(existing, 2), 3)
  if (row.status === 2 && (!identity || !renderInfo || !executing || text(executing, 5) !== 'Executing')) {
    throw new StepLayoutError(`step ${row.idx} is not the measured pending tool-call layout`)
  }
  if (row.status === 1 && (identity || renderInfo)) {
    throw new StepLayoutError(`step ${row.idx} is not the measured queued tool-call layout`)
  }
  // `140` holds the argument pairs (field 1) and, once agy started the call, one render block (field 2); nothing else.
  let renderBlocks = 0
  for (const block of existing) {
    if (block.field === 2 && block.wt === 2) {
      if (++renderBlocks > 1) throw new StepLayoutError(`step ${row.idx} holds two render blocks`)
      continue
    }
    if (block.field !== 1 || block.wt !== 2) throw new StepLayoutError(`step ${row.idx} holds an unrecognized result block`)
    const arg = message([block], 1)
    if (!arg || text(arg, 1) === null || text(arg, 2) === null) throw new StepLayoutError(`step ${row.idx} holds an unrecognized argument`)
  }
  const step20 = sub(step5, 20)
  const conversation = text(step20, 4)
  const trajectory = text(step20, 1)
  if (conversation === null || trajectory === null) throw new StepLayoutError(`step ${row.idx} does not name its conversation and trajectory`)
  const name = text(call, 2)
  if (!name) throw new StepLayoutError(`step ${row.idx} names no tool`)

  const now = output.completed.getTime()
  const seconds = Math.floor(now / 1000)
  const nanos = Math.round((now % 1000) * 1e6)
  const completedStamp = [{ field: 1, wt: 0 as const, value: seconds }, { field: 2, wt: 0 as const, value: nanos }]

  setInteger(payload, 4, 3)
  setMessage(step5, 8, completedStamp)
  setMessage(payload, 5, step5)

  // The result block: arguments (140.1) are already there; 140.2 is the result agy renders.
  const result = sub(payload, 140)
  const rendered = storedOutput(output)
  const body = `**Arguments**\n\`\`\`json\n${JSON.stringify(argumentsOf(result), null, 2)}\n\`\`\`\n\n**Result**\n\`\`\`\n${rendered}\n\`\`\``
  const render = message(result, 2) ?? []
  // A queued call never got agy's tool identity and render metadata; build them from the measured shape.
  if (row.status === 1) {
    if (!message(payload, 133)) setMessage(payload, 133, toolIdentity(name))
    if (!message(payload, 147)) setMessage(payload, 147, renderMetadata(name, trajectory, row.idx))
  }
  const inner = message(render, 3) ?? []
  setText(render, 1, rendered)
  setText(inner, 5, 'Executed')
  const markdown = message(inner, 10) ?? []
  setText(markdown, 1, body)
  setMessage(inner, 10, markdown)
  setMessage(render, 3, inner)
  setText(render, 7, output.outputUrl)
  setMessage(result, 2, render)
  setMessage(payload, 140, result)

  const metadata = row.metadata ? decode(row.metadata) : []
  setMessage(metadata, 8, completedStamp)
  return { ...row, status: 3, step_payload: encode(payload), metadata: encode(metadata) }
}

/** The step's argument pairs (`140.1`) as an object, without agy's own summary field. */
function argumentsOf(result: Field[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const pair of result) {
    if (pair.field !== 1 || pair.wt !== 2) continue
    const decoded = message([pair], 1)
    if (!decoded) continue
    const key = text(decoded, 1)
    if (key === null || key === 'toolSummary') continue
    out[key] = text(decoded, 2) ?? ''
  }
  return out
}

/** Message field helpers: a length-delimited string, a nested message, a varint. */
const textField = (field: number, text: string): Field => ({ field, wt: 2, value: new TextEncoder().encode(text) })
const messageField = (field: number, tree: Field[]): Field => ({ field, wt: 2, value: encode(tree) })
const intField = (field: number, value: number): Field => ({ field, wt: 0, value })

/** `mcp` / `<server>/<tool>`, as agy names an MCP tool call. */
function serverTool(name: string): { server: string; tool: string; pair: Field[] } {
  const at = name.indexOf('_', 4)
  if (!name.startsWith('mcp_') || at < 0) throw new StepLayoutError(`tool '${name}' is not an MCP tool call`)
  const server = name.slice(4, at), tool = name.slice(at + 1)
  return { server, tool, pair: [textField(1, 'mcp'), textField(2, `${server}/${tool}`)] }
}

/** The tool identity (`133`) of an MCP tool call. */
function toolIdentity(name: string): Field[] {
  const { server, tool, pair } = serverTool(name)
  return [messageField(2, [messageField(1, pair), intField(2, 1), textField(5, 'mcp'), textField(6, `${server}/${tool}`)])]
}

/** The render metadata (`147`) of a tool-call step: the tool's identity, its title and the step's own position. */
function renderMetadata(name: string, trajectory: string, idx: number): Field[] {
  const { server, tool, pair } = serverTool(name)
  const header = [messageField(21, [messageField(1, pair), textField(5, `Run ${tool} from MCP server ${server}`), messageField(6, [intField(1, 5)])])]
  const position = [textField(1, trajectory), intField(2, idx), messageField(21, [intField(1, 1), textField(4, '')])]
  return [messageField(1, header), messageField(2, position)]
}


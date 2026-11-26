// The agy store format's own units: the protobuf tree editor round-trips every wire type agy writes, the step writer
// accepts exactly the layout that was measured, and a large output's preview is agy's byte rule.
import { assert, assertEquals, assertMatch, assertThrows } from '@std/assert'
import { decode, encode, type Field } from '../src/agy/pb.ts'
import { type StepsRow, stepsRowFromJson } from '../src/agy/rows.ts'
import { completeStep, MAX_STORED_OUTPUT_BYTES, outputFileText, preview, stamp, StepLayoutError, storedOutput, type StepOutput } from '../src/agy/step.ts'

const bytes = (value: string) => new TextEncoder().encode(value)
const field = (n: number, value: number | Uint8Array | string, wt?: 0 | 1 | 2 | 5): Field => {
  if (typeof value === 'number') return { field: n, wt: wt ?? 0, value: BigInt(value) }
  return { field: n, wt: wt ?? 2, value: typeof value === 'string' ? bytes(value) : value }
}
const message = (n: number, fields: Field[]): Field => ({ field: n, wt: 2, value: encode(fields) })

Deno.test('agy pb: decode then encode gives back the same bytes for every wire type agy writes', () => {
  const fields: Field[] = [
    field(1, 14),
    field(2, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), 1),
    field(3, new Uint8Array([9, 10, 11, 12]), 5),
    message(5, [field(1, 132), message(20, [field(1, 'a conversation'), field(4, 'a trajectory')])]),
    field(35, 'a uuid'),
    field(38, 3),
  ]
  const bytes = encode(fields)
  const decoded = decode(bytes)
  assertEquals(encode(decoded).length, bytes.length)
  assertEquals([...encode(decoded)], [...bytes])
  // a nested message with a fixed-width field survives the trip too, which a length-prefixed re-encode would not
  const nested = message(7, [field(1, new Uint8Array([0xde, 0xad, 0xbe, 0xef]), 5), field(2, 1)])
  const outer = decode(encode([nested]))
  assertEquals([...encode(outer)], [...encode([nested])])
})

function row(overrides: Partial<StepsRow> = {}): StepsRow {
  const conversation = '11111111-2222-4333-8444-555555555555'
  const trajectory = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  const step5 = [
    field(1, 1_700_000_000),
    field(3, 2),
    message(4, [field(1, 'call_abc'), field(2, 'mcp_responses_echo'), field(3, '{"value":"ALPHA"}')]),
    message(20, [field(1, trajectory), field(2, 7), field(3, 2), field(4, conversation)]),
  ]
  const payload = [
    field(1, 132),
    field(4, 2),
    message(5, step5),
    message(133, [message(2, [message(1, [field(1, 'mcp'), field(2, 'responses/echo')]), field(2, 1), field(5, 'mcp'), field(6, 'responses/echo')])]),
    message(147, [
      message(1, [message(21, [message(1, [field(1, 'mcp'), field(2, 'responses/echo')]), field(5, 'Run echo from MCP server responses'), message(6, [field(1, 5)])])]),
      message(2, [field(1, trajectory), field(2, 7), message(21, [field(1, 1), field(4, '')])]),
    ]),
    message(140, [
      message(1, [field(1, 'toolSummary'), field(2, 'Echo call')]),
      message(1, [field(1, 'value'), field(2, 'ALPHA')]),
      message(2, [message(3, [field(5, 'Executing'), field(6, 'build'), field(7, 'actions')])]),
    ]),
  ]
  return {
    idx: 7,
    step_type: 132,
    status: 2,
    has_subtrajectory: 0,
    metadata: encode(step5),
    error_details: null,
    permissions: null,
    task_details: null,
    render_info: null,
    step_payload: encode(payload),
    step_format: 0,
    ...overrides,
  }
}

const output = (text: string): StepOutput => ({
  text,
  created: new Date('2026-11-26T08:00:00Z'),
  completed: new Date('2026-11-26T08:00:01Z'),
  outputUrl: 'file:///state/gemini/antigravity-cli/brain/11111111-2222-4333-8444-555555555555/.system_generated/steps/7/output.txt',
})

Deno.test('agy step: a pending step is completed in agy\'s own shape, and nothing else is accepted', () => {
  const done = completeStep(row(), output('ECHO ALPHA echoed'))
  assertEquals(done.status, 3)
  const payload = decode(done.step_payload!)
  assertEquals(payload.find((f) => f.field === 4)?.value, 3n)
  const step5 = payload.find((f) => f.field === 5)!.value as Uint8Array
  assert(decode(step5).some((f) => f.field === 8), 'the completion timestamp is missing')
  const rendered = decode(payload.find((f) => f.field === 140)!.value as Uint8Array)
  const render = decode(rendered.find((f) => f.field === 2)!.value as Uint8Array)
  const stored = new TextDecoder().decode(render.find((f) => f.field === 1)!.value as Uint8Array)
  assertMatch(stored, /^Created At: \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d\nCompleted At: \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d\nECHO ALPHA echoed$/)
  assertEquals(stored, new TextDecoder().decode(outputFileText(output('ECHO ALPHA echoed'))))
  assertEquals(new TextDecoder().decode(render.find((f) => f.field === 7)!.value as Uint8Array), output('').outputUrl)
  const inner = decode(render.find((f) => f.field === 3)!.value as Uint8Array)
  assertEquals(new TextDecoder().decode(inner.find((f) => f.field === 5)!.value as Uint8Array), 'Executed')
  // an unrecognized block in the result, a missing tool identity, a missing render block, or a finished row: refused
  const payloadOf = (r: StepsRow) => decode(r.step_payload!)
  const withExtra = row()
  const extraPayload = payloadOf(withExtra)
  const result = decode(extraPayload.find((f) => f.field === 140)!.value as Uint8Array)
  result.push(field(3, 'unexpected'))
  extraPayload.find((f) => f.field === 140)!.value = encode(result)
  withExtra.step_payload = encode(extraPayload)
  assertThrows(() => completeStep(withExtra, output('x')), StepLayoutError, 'unrecognized result block')
  const noIdentity = row()
  const noIdentityPayload = payloadOf(noIdentity).filter((f) => f.field !== 133)
  noIdentity.step_payload = encode(noIdentityPayload)
  assertThrows(() => completeStep(noIdentity, output('x')), StepLayoutError, 'pending tool-call layout')
  assertThrows(() => completeStep(row({ status: 3 }), output('x')), StepLayoutError, 'not a pending tool call')
})

Deno.test('agy step: a large output is stored as agy\'s preview over the output file\'s bytes', () => {
  const big = `BIG ${'x'.repeat(30_000)} TAIL`
  const written = output(big)
  const file = outputFileText(written)
  assertEquals(new TextDecoder().decode(file).startsWith('Created At: '), true)
  const stored = storedOutput(written)
  assert(stored.startsWith("The tool's output was truncated due to being too long."))
  assert(stored.endsWith('TAIL'))
  const bytes = new TextEncoder().encode(stored).length
  assert(bytes <= 10_240, `preview is ${bytes} bytes`)
  assert(bytes >= 10_238, `preview is only ${bytes} bytes`)
  // agy stores the output whole at exactly the cap and previews one byte over it
  const header = new TextEncoder().encode(`Created At: ${stamp(written.created)}\nCompleted At: ${stamp(written.completed)}\n`).length
  const whole = output('y'.repeat(MAX_STORED_OUTPUT_BYTES - header))
  assertEquals(outputFileText(whole).length, MAX_STORED_OUTPUT_BYTES)
  assertEquals(storedOutput(whole), new TextDecoder().decode(outputFileText(whole)))
  const over = output('y'.repeat(MAX_STORED_OUTPUT_BYTES - header + 1))
  assert(storedOutput(over).startsWith("The tool's output was truncated due to being too long."))
})

Deno.test('agy step: the middle line names what is missing, counted from the previewed text', () => {
  const full = new TextEncoder().encode('a'.repeat(20_000))
  const shown = preview(full, 'file:///tmp/output.txt')
  const match = /<truncated (\d+) of (\d+) bytes from the middle of the output>/.exec(shown)
  assert(match, shown.slice(0, 200))
  assertEquals(Number(match![2]), 20_000)
  // the head is everything between the notice and the middle line; the tail is as long as it
  const notice = "The tool's output was truncated due to being too long. You can find the full output in a file at file:///tmp/output.txt.\n\nHere is a preview with the middle of the output truncated:\n"
  assertEquals(shown.startsWith(notice), true)
  const head = shown.slice(notice.length, shown.indexOf('\n<truncated'))
  const headBytes = new TextEncoder().encode(head).length
  assertEquals(Number(match![1]), 20_000 - 2 * headBytes)
  assertEquals(new TextEncoder().encode(shown).length <= 10_240, true)
})

Deno.test('agy step: a multibyte output is cut exactly as agy cuts it, on whole characters', async () => {
  // measured on agy 1.5.17 from a live large call: 4,000 emoji and 3,000 CJK characters plus markers
  const fixture = JSON.parse(await Deno.readTextFile(new URL('./fixtures/agy-preview-multibyte.json', import.meta.url)))
  const full = new TextEncoder().encode(fixture.full)
  const shown = preview(full, fixture.url)
  assertEquals(new TextEncoder().encode(fixture.stored).length, 10_238)
  assertEquals(shown, fixture.stored)
  assertEquals(shown.includes('\uFFFD'), false)
  // every character of the head and the tail is whole, and the middle line counts bytes
  const match = /<truncated (\d+) of (\d+) bytes from the middle of the output>/.exec(shown)!
  assertEquals(Number(match[2]), full.length)
  assertEquals(Number(match[1]), full.length - 4_930 - 4_929)
})

Deno.test('agy pb: rows as agy wrote them round-trip byte for byte, fixed-width fields and big varints included', () => {
  const fixture = JSON.parse(Deno.readTextFileSync(new URL('./fixtures/agy-step-rows.json', import.meta.url))) as { rows: any[] }
  assert(fixture.rows.length >= 3, 'the fixture holds the rows a real store had')
  const blobs: Uint8Array[] = []
  for (const json of fixture.rows) {
    const row = stepsRowFromJson(json)
    const columns = ['metadata', 'error_details', 'permissions', 'task_details', 'render_info', 'step_payload'] as const
    for (const column of columns) {
      const bytes = row[column]
      if (bytes) blobs.push(bytes)
    }
  }
  assert(blobs.length >= 4, 'no row bytes to round-trip')
  for (const bytes of blobs) {
    const again = encode(decode(bytes))
    assertEquals(again.length, bytes.length)
    assertEquals([...again], [...bytes])
  }
  // a varint past a JS number's precision keeps its exact bytes: decode must not round it into another value
  const value = 2n ** 60n + 7n
  const raw = [0x08]
  for (let v = value;;) {
    const byte = Number(v & 0x7fn)
    v >>= 7n
    if (v) raw.push(byte | 0x80)
    else {
      raw.push(byte)
      break
    }
  }
  const bytes = new Uint8Array(raw)
  assertEquals([...encode(decode(bytes))], raw)
  assertEquals(decode(bytes)[0].value, value)
})

/** A row's payload with its status rewritten and its result block replaced (or removed). */
function withResult(status: number, result: Uint8Array | null): Uint8Array {
  const base = decode(row().step_payload!)
  const kept = base
    .map((f) => (f.field === 4 ? { ...f, value: BigInt(status) } : f))
    .filter((f) => f.field !== 140 && !(status === 1 && (f.field === 133 || f.field === 147)))
  if (result !== null) kept.push({ field: 140, wt: 2, value: result })
  return encode(kept)
}

Deno.test('agy step: a result block that is not a message is refused; a queued call may have none, or an empty one', () => {
  // a pending call must carry the measured render block: bytes that are not a message are a layout we do not know
  assertThrows(() => completeStep(row({ step_payload: withResult(2, new Uint8Array([0xff, 0xff, 0xff])) }), output('x')), StepLayoutError)
  // a queued call (agy has not started it) legitimately has no block, or one with no render yet
  assertEquals(completeStep(row({ status: 1, step_payload: withResult(1, null) }), output('x')).status, 3)
  assertEquals(completeStep(row({ status: 1, step_payload: withResult(1, new Uint8Array()) }), output('x')).status, 3)
  // and garbage there is refused rather than overwritten, as on a pending call
  assertThrows(() => completeStep(row({ status: 1, step_payload: withResult(1, new Uint8Array([0x0a, 0x7f])) }), output('x')), StepLayoutError)
})

Deno.test('agy step: a U+FEFF a tool printed is that character, not a BOM to strip, and every byte is counted', () => {
  const url = 'file:///state/gemini/antigravity-cli/brain/id/.system_generated/steps/7/output.txt'
  const notice = `The tool's output was truncated due to being too long. You can find the full output in a file at ${url}.\n\nHere is a preview with the middle of the output truncated:\n`
  const total = 30_000
  // where a preview of this size puts its tail, measured on ASCII text of the same length
  const probe = preview(new Uint8Array(total).fill(0x61), url)
  const middle = /\n<truncated (\d+) of (\d+) bytes from the middle of the output>\n/.exec(probe)!
  const tailBytes = bytes(probe.slice(probe.indexOf(middle[0]) + middle[0].length)).length
  // the same text with a byte-order-mark character exactly where the retained suffix begins
  const content = `${'a'.repeat(total - tailBytes)}\uFEFF${'a'.repeat(tailBytes - 3)}`
  assertEquals(bytes(content).length, total)
  const text = preview(bytes(content), url)
  const kept = text.slice(notice.length)
  const split = /\n<truncated (\d+) of (\d+) bytes from the middle of the output>\n/.exec(kept)!
  const head = kept.slice(0, split.index)
  const tail = kept.slice(split.index + split[0].length)
  assert(tail.startsWith('\uFEFF'), 'the retained suffix lost the character the tool printed')
  // every byte of the output is either kept or counted in the middle line
  const missing = Number(split[1])
  assertEquals(Number(split[2]), total)
  assertEquals(bytes(head).length + bytes(tail).length + missing, total)
  assertEquals(bytes(text).length <= 10_240, true)
})

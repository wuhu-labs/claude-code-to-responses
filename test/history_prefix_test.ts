// The supplied history is the context: the matcher reuses the longest record-backed prefix it can place, and a
// record whose covered items the client visibly changed is a typed 400, not a silent synthesis.
import { assertEquals, assertRejects } from '@std/assert'
import { text } from './fake.ts'
import { messagesOf, send, user } from './harness.ts'
import { INSTRUCTIONS, MODEL, Run, TOOLS } from './scenario.ts'

const body = { model: MODEL, instructions: INSTRUCTIONS, tools: TOOLS }
const bad = (e: unknown) => e as { status?: number; code?: string; error?: { code?: string } }

/** Two completed text turns; the history the client keeps after each. */
async function twoTurns(run: Run): Promise<{ a: string; x: unknown[]; b: string; y: unknown[] }> {
  run.fake.reply({ blocks: [text('reply A')] })
  const a = await run.turn('A')
  run.fake.reply({ blocks: [text('reply B')] })
  const b = await run.turn('B')
  return { a: a.response.id, x: a.response.output, b: b.response.id, y: b.response.output }
}

Deno.test('history: unchanged prefix plus a new tail continues from the earlier response, never the later live one', async () => {
  const run = new Run('prefix-branch', false, { mode: 'history' })
  await run.run(async () => {
    const t = await twoTurns(run)
    run.fake.reply({ blocks: [text('reply C')] })
    await run.turn('C')
    // branch from B: keep A and B, send X instead of a later turn
    run.fake.reply({ blocks: [text('reply X')] })
    const r = await send(run.tg.client, { ...body, input: [user('A'), ...t.x, user('B'), ...t.y, user('X')] })
    assertEquals([r.status, r.response.x_gateway.path, r.response.x_gateway.records, r.response.x_gateway.synthesized_groups], ['completed', 'history', 2, 0])
    const seen = messagesOf(run.fake.main().at(-1)!).join('\n')
    assertEquals(['A', 'reply A', 'B', 'reply B', 'X'].every((s) => seen.includes(s)), true)
    assertEquals(seen.includes('reply C'), false)
  })
})

Deno.test('history: a changed prefix that still carries its old reasoning is a typed 400', async () => {
  const run = new Run('prefix-changed', false, { mode: 'history' })
  await run.run(async () => {
    const t = await twoTurns(run)
    const before = run.fake.main().length
    const err = bad(await assertRejects(() => send(run.tg.client, { ...body, input: [user('A edited'), ...t.x, user('B'), ...t.y, user('X')] })))
    assertEquals([err.status, err.code ?? err.error?.code], [400, 'history_mismatch'])
    assertEquals(run.fake.main().length, before)
  })
})

Deno.test('history: two records sent in an order their own links contradict are a typed 400', async () => {
  const run = new Run('prefix-order', false, { mode: 'history' })
  await run.run(async () => {
    const t = await twoTurns(run)
    const before = run.fake.main().length
    const err = bad(await assertRejects(() => send(run.tg.client, { ...body, input: [user('B'), ...t.y, user('A'), ...t.x, user('X')] })))
    assertEquals([err.status, err.code ?? err.error?.code], [400, 'history_mismatch'])
    assertEquals(String((err as { message?: string }).message).includes('before its parent'), true)
    assertEquals(run.fake.main().length, before)
  })
})

Deno.test('history: an empty state dir rebuilds from the records the client carries', async () => {
  const run = new Run('prefix-cold', false, { mode: 'history' })
  await run.run(async () => {
    const t = await twoTurns(run)
    await run.disrupt('restart-lost-store')
    run.fake.reply({ blocks: [text('reply X')] })
    const r = await send(run.tg.client, { ...body, input: [user('A'), ...t.x, user('B'), ...t.y, user('X')] })
    assertEquals([r.status, r.response.x_gateway.path, r.response.x_gateway.records, r.response.x_gateway.synthesized_groups], ['completed', 'history', 2, 0])
    const seen = messagesOf(run.fake.main().at(-1)!).join('\n')
    assertEquals(['A', 'reply A', 'B', 'reply B', 'X'].every((s) => seen.includes(s)), true)
  })
})

Deno.test('history: fresh input with several user messages and no reasoning is a new conversation in order', async () => {
  const run = new Run('prefix-fresh', false)
  await run.run(async () => {
    run.fake.reply({ blocks: [text('reply')] })
    const r = await send(run.tg.client, { ...body, input: [user('first'), user('second')] })
    assertEquals([r.status, r.response.x_gateway.path], ['completed', 'new'])
    const seen = messagesOf(run.fake.main()[0]).join('\n')
    assertEquals(seen.indexOf('first') < seen.indexOf('second'), true)
  })
})

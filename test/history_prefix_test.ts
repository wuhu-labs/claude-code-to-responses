// The supplied history is the context: the matcher reuses the longest record-backed prefix it can place, and a
// record whose covered items the client visibly changed is a typed 400, not a silent synthesis.
import { assertEquals, assertRejects } from '@std/assert'
import { type Exchange, text } from './fake.ts'
import { send, unmark, user } from './harness.ts'
import { INSTRUCTIONS, MODEL, Run, TOOLS } from './scenario.ts'

const body = { model: MODEL, instructions: INSTRUCTIONS, tools: TOOLS }
const bad = (e: unknown) => e as { status?: number; code?: string; error?: { code?: string }; message?: string }

/** The client's own model-visible turns, in order: cache markers and Claude Code's environment block removed. */
function turns(ex: Exchange): { role: string; text: string[] }[] {
  return (ex.body.messages as { role: string; content: unknown }[]).map((m) => unmark(m)).filter((m) => m.role !== 'system').map((m) => ({
    role: m.role,
    text: typeof m.content === 'string' ? [m.content] : (m.content as { type: string; text: string }[]).filter((b) => b.type === 'text').map((b) => b.text),
  }))
}

/** Two completed text turns; the history the client keeps after each. */
async function twoTurns(run: Run): Promise<{ a: string; x: unknown[]; b: string; y: unknown[] }> {
  run.fake.reply({ blocks: [text('reply A')] })
  const a = await run.turn('A')
  run.fake.reply({ blocks: [text('reply B')] })
  const b = await run.turn('B')
  return { a: a.response.id, x: a.response.output, b: b.response.id, y: b.response.output }
}

const spoken = (t: { a: string; x: unknown[]; b: string; y: unknown[] }, a = 'A', b = 'B', x = 'X') => [user(a), ...t.x, user(b), ...t.y, user(x)]

Deno.test('history: unchanged prefix plus a new tail continues from the earlier response, never the later live one', async () => {
  const run = new Run('prefix-branch', false, { mode: 'history' })
  await run.run(async () => {
    const t = await twoTurns(run)
    run.fake.reply({ blocks: [text('reply C')] })
    await run.turn('C')
    // branch from B: keep A and B, send X instead of a later turn
    run.fake.reply({ blocks: [text('reply X')] })
    const r = await send(run.tg.client, { ...body, input: spoken(t) })
    assertEquals([r.status, r.response.x_gateway.path, r.response.x_gateway.records, r.response.x_gateway.synthesized_groups], ['completed', 'history', 2, 0])
    assertEquals(turns(run.fake.main().at(-1)!), [
      { role: 'user', text: ['A'] },
      { role: 'assistant', text: ['reply A'] },
      { role: 'user', text: ['B'] },
      { role: 'assistant', text: ['reply B'] },
      { role: 'user', text: ['X'] },
    ])
  })
})

Deno.test('history: a changed prefix that still carries its old reasoning is a typed 400', async () => {
  const run = new Run('prefix-changed', false, { mode: 'history' })
  await run.run(async () => {
    const t = await twoTurns(run)
    const before = run.fake.main().length
    const err = bad(await assertRejects(() => send(run.tg.client, { ...body, input: spoken(t, 'A edited') })))
    assertEquals([err.status, err.code ?? err.error?.code], [400, 'history_mismatch'])
    assertEquals(run.fake.main().length, before)
  })
})

Deno.test('history: a changed tool set alone does not stand in for an edit, and does not hide one', async () => {
  const run = new Run('prefix-tools', false, { mode: 'history' })
  await run.run(async () => {
    const t = await twoTurns(run)
    const tools = TOOLS.filter((tool) => tool.name === 'echo')
    // the unchanged items under a new tool set: no record is reusable, but no content is called changed either
    run.fake.reply({ blocks: [text('reply X')] })
    const plain = await send(run.tg.client, { ...body, tools, input: spoken(t) })
    assertEquals([plain.status, plain.response.x_gateway.records, plain.response.x_gateway.synthesized_groups], ['completed', 0, 2])
    // the same tool change with an edited prompt: the edit is still visible through the record's own comparison
    const before = run.fake.main().length
    const err = bad(await assertRejects(() => send(run.tg.client, { ...body, tools, input: spoken(t, 'A edited') })))
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
    assertEquals(String(err.message).includes('before its parent'), true)
    assertEquals(run.fake.main().length, before)
  })
})

Deno.test('history: a record sent in the same group as its parent is a typed 400, not a silent synthesis', async () => {
  const run = new Run('prefix-boundary', false, { mode: 'history' })
  await run.run(async () => {
    const t = await twoTurns(run)
    const before = run.fake.main().length
    // B's user message is deleted, so the linked records A and B land in one output group
    const err = bad(await assertRejects(() => send(run.tg.client, { ...body, input: [user('A'), ...t.x, ...t.y, user('X')] })))
    assertEquals([err.status, err.code ?? err.error?.code], [400, 'history_mismatch'])
    assertEquals(String(err.message).includes('same response group'), true)
    assertEquals(run.fake.main().length, before)
  })
})

Deno.test('history: a thinking item that cannot be replayed is a typed 400 before any model call', async () => {
  const run = new Run('prefix-thinking', false)
  await run.run(async () => {
    const before = run.fake.main().length
    for (const encrypted_content of ['cc2r.thinking.v1.%%%', `cc2r.thinking.v1.${btoa('{}')}`]) {
      const err = bad(await assertRejects(() =>
        send(run.tg.client, { ...body, input: [user('A'), { type: 'reasoning', summary: [], encrypted_content }, user('next')] })
      ))
      assertEquals([err.status, err.code ?? err.error?.code], [400, 'unexpected_reasoning_item'])
    }
    assertEquals(run.fake.main().length, before)
  })
})

Deno.test('history: an empty state dir rebuilds from the records the client carries', async () => {
  const run = new Run('prefix-cold', false, { mode: 'history' })
  await run.run(async () => {
    const t = await twoTurns(run)
    await run.disrupt('restart-lost-store')
    run.fake.reply({ blocks: [text('reply X')] })
    const r = await send(run.tg.client, { ...body, input: spoken(t) })
    assertEquals([r.status, r.response.x_gateway.path, r.response.x_gateway.records, r.response.x_gateway.synthesized_groups], ['completed', 'history', 2, 0])
    assertEquals(turns(run.fake.main().at(-1)!), [
      { role: 'user', text: ['A'] },
      { role: 'assistant', text: ['reply A'] },
      { role: 'user', text: ['B'] },
      { role: 'assistant', text: ['reply B'] },
      { role: 'user', text: ['X'] },
    ])
  })
})

Deno.test('history: fresh input with several user messages and no reasoning is a new conversation in order', async () => {
  const run = new Run('prefix-fresh', false)
  await run.run(async () => {
    run.fake.reply({ blocks: [text('reply')] })
    const r = await send(run.tg.client, { ...body, input: [user('first'), user('second')] })
    assertEquals([r.status, r.response.x_gateway.path], ['completed', 'new'])
    assertEquals(turns(run.fake.main()[0]), [{ role: 'user', text: ['first', 'second'] }])
  })
})

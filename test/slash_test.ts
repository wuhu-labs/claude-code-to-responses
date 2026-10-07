import { assert, assertEquals } from '@std/assert'
import { type Part } from '../src/api/request.ts'
import { contentBlocks, contextOf, toolResultEntry, userContentBlocks, userContentEntry, userMessageEntry } from '../src/claude/entries.ts'
import { contentFor, mcpResult } from '../src/lane.ts'
import { call, type Json, text } from './fake.ts'
import { assertPrefix, output, user } from './harness.ts'
import { IMAGE, IMAGE_BLOCK, PNG } from './images.ts'
import { Run } from './scenario.ts'

Deno.test('only a last user block with a command-shaped token receives one space; other content and caller data stay unchanged', () => {
  const image: Part = { type: 'image', mediaType: 'image/png', data: PNG }
  const cases: [Part[], boolean][] = [
    ...['/compact', '/cost', '/context', '/foo', '/COST', '/cost hello', '/cost\nhello', '/foo-bar', '/foo:bar', '/_foo'].map((
      text,
    ): [Part[], boolean] => [[{ type: 'text', text }], true]),
    ...[' /cost', '\n/cost', '\t/cost', 'hi /cost', '\u200b/cost', '/', '//cost', '/ cost', '/tmp/file', '/foo.bar', '/!', '/é', '/-foo', '/:foo'].map((
      text,
    ): [Part[], boolean] => [[{ type: 'text', text }], false]),
    [[{ type: 'text', text: 'prefix' }, { type: 'text', text: '/cost' }], true],
    [[image, { type: 'text', text: '/cost' }], true],
    [[{ type: 'text', text: '/cost' }, image], false],
    [[{ type: 'text', text: '/cost' }, { type: 'text', text: '' }], false],
    [[{ type: 'text', text: '/co' }, { type: 'text', text: 'st' }], false],
  ]
  for (const [parts, transform] of cases) {
    const original = structuredClone(parts), expected = contentBlocks(parts)
    if (transform) expected.at(-1).text = ' ' + expected.at(-1).text
    assertEquals(userContentBlocks(parts), expected)
    assertEquals(contentFor(parts), expected)
    assertEquals(parts, original)
    const ctx = () => contextOf([], 'test', '/tmp')
    assertEquals(userContentEntry(ctx(), parts).message.content, expected)
    assertEquals(userMessageEntry(ctx(), parts).message.content, expected)
    assertEquals(toolResultEntry(ctx(), 'toolu_test', parts, null).message.content[0].content, contentBlocks(parts))
    assertEquals(mcpResult(parts).content.at(-1)?.text, parts.at(-1)?.type === 'text' ? (parts.at(-1) as { text: string }).text : undefined)
  }
})

Deno.test('slash-leading stdin user text is model input, including later text blocks and text after an image; record rebuild repeats the bytes', async () => {
  const run = new Run('slash-turn', false)
  await run.run(async () => {
    const cases = [
      ...['/compact', '/cost', '/context', '/foo', ' /cost', '\n/cost', 'hi /cost'].map((s) => ({
        item: user(s),
        expected: [s.startsWith('/') ? ' ' + s : s],
      })),
      { item: { role: 'user', content: [{ type: 'input_text', text: 'prefix' }, { type: 'input_text', text: '/cost' }] }, expected: ['prefix', ' /cost'] },
      { item: { role: 'user', content: [IMAGE, { type: 'input_text', text: '/compact' }] }, expected: [' /compact\n'] },
    ]
    for (const { item, expected } of cases) {
      const n = run.fake.main().length
      run.fake.reply({ blocks: [text('model answer')] })
      const r = await run.send([item])
      assertEquals(r.status, 'completed')
      assertEquals(run.drv.text(r), 'model answer')
      assertEquals(run.fake.main().length, n + 1)
      const last = run.fake.main().at(-1)!.body.messages.filter((m: Json) =>
        m.role === 'user' && m.content.some((b: Json) => b.type === 'text' && !b.text.startsWith('# Environment\n'))
      ).at(-1)
      assertEquals(
        last.content.filter((b: Json) => b.type === 'text' && !b.text.startsWith('[Image: source:') && !b.text.startsWith('# Environment\n')).map((b: Json) =>
          b.text
        ),
        expected,
      )
      if (item.content instanceof Array && item.content[0].type === 'input_image') assertEquals(last.content.find((b: Json) => b.type === 'image'), IMAGE_BLOCK)
      assert(!run.fake.main().at(-1)!.raw.includes("The user's message starts with the slash command"))
    }
    const before = run.fake.main().at(-1)!
    await run.disrupt('idle')
    await run.turn('/context')
    assertPrefix(before, run.fake.main().at(-1)!)
    const evicted = run.fake.main().at(-1)!
    await run.disrupt('restart-lost-store')
    await run.turn('/compact')
    assertPrefix(evicted, run.fake.main().at(-1)!)
    assertEquals(run.tg.events('spawn').length, 1)
  })
})

for (const path of ['live-hook', 'evicted-text', 'image-first', 'image-last'] as const) {
  Deno.test(`slash notices on ${path}: no local command, loss, or rewriting of tool results; history recovery preserves exact bytes`, async () => {
    const run = new Run(`slash-${path}`, false)
    await run.run(async () => {
      for (const command of ['/compact', '/cost', '/context', '/foo']) {
        const id = `toolu_slash_${run.fake.main().length}`
        run.fake.reply({ blocks: [call(id, 'echo', { text: 'x' })] })
        await run.send([user('tool please')])
        await run.tg.waitEvent('hold', (d) => d.call === id)
        if (path === 'evicted-text') await run.disrupt('hold')
        const content = path === 'image-first'
          ? [IMAGE, { type: 'input_text', text: command }]
          : path === 'image-last'
          ? [{ type: 'input_text', text: command }, IMAGE]
          : command
        const n = run.fake.main().length
        run.fake.reply({ blocks: [text('notice received')] })
        const r = await run.send([output(id, '/cost'), { role: 'user', content }])
        assertEquals(r.status, 'completed')
        assertEquals(run.drv.text(r), 'notice received')
        assertEquals(run.fake.main().length, n + 1)
        const after = run.fake.main().at(-1)!, msgs = after.body.messages
        const result = msgs.flatMap((m: Json) => m.content instanceof Array ? m.content : []).find((b: Json) =>
          b.type === 'tool_result' && b.tool_use_id === id
        )
        assertEquals(result.content[0].text, '/cost', 'tool outputs are not command input')
        if (path === 'live-hook') assertEquals(msgs.at(-1).content[0].text, `PostToolUse:mcp__fn__echo hook additional context: ${command}`)
        else {
          const texts = msgs.at(-1).content.filter((b: Json) =>
            b.type === 'text' && !b.text.startsWith('[Image: source:') && !b.text.startsWith('# Environment\n')
          )
          assertEquals(texts.map((b: Json) => b.text), [path === 'image-last' ? command : ' ' + command + (path === 'image-first' ? '\n' : '')])
          if (path.startsWith('image')) assertEquals(msgs.at(-1).content.find((b: Json) => b.type === 'image'), IMAGE_BLOCK)
        }
        assert(!after.raw.includes("The user's message starts with the slash command"))
        await run.disrupt('restart-lost-store')
        await run.turn('history continuation')
        assertPrefix(after, run.fake.main().at(-1)!)
      }
    })
  })
}

Deno.test('recordless slash-leading history synthesizes the same user boundary, without touching assistant text or tool outputs', async () => {
  const run = new Run('slash-synth', false, { mode: 'history' })
  await run.run(async () => {
    run.fake.reply({ blocks: [text('model answer')] })
    const r = await run.send([
      user('/compact'),
      { role: 'assistant', content: '/cost' },
      { type: 'function_call', call_id: 'toolu_synthslash', name: 'echo', arguments: '{"text":"x"}' },
      output('toolu_synthslash', '/context'),
      user('/foo'),
    ])
    assertEquals(r.status, 'completed')
    assertEquals(run.drv.text(r), 'model answer')
    assert(r.response.x_gateway.synthesized_groups > 0)
    const before = run.fake.main()[0]
    const blocks = (role: string) => before.body.messages.filter((m: Json) => m.role === role).flatMap((m: Json) => m.content)
    assert(blocks('user').some((b: Json) => b.type === 'text' && b.text === ' /compact'))
    assert(blocks('user').some((b: Json) => b.type === 'text' && b.text === ' /foo'))
    assert(blocks('assistant').some((b: Json) => b.type === 'text' && b.text === '/cost'))
    assertEquals(blocks('user').find((b: Json) => b.type === 'tool_result').content[0].text, '/context')
    await run.disrupt('restart-lost-store')
    await run.turn('/cost')
    assertPrefix(before, run.fake.main()[1])
  })
})

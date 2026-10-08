// Claude Code owns unknown-tool recovery; the gateway only holds declared MCP calls.
import { assert, assertEquals, assertStringIncludes } from '@std/assert'
import { decodeRecord } from '../src/records.ts'
import { call, type Json, text } from './fake.ts'
import { assertOneUserId, assertPrefix, output, user } from './harness.ts'
import { Run, scenarioTest } from './scenario.ts'

const bare = (id: string, name: string, input: Json = {}) => ({ type: 'tool_use' as const, id, name, input })
const results = (body: Json) => body.messages.flatMap((m: Json) => Array.isArray(m.content) ? m.content : []).filter((b: Json) => b.type === 'tool_result')
const recordOf = async (r: Json) => await decodeRecord(r.response.output.at(-1).encrypted_content)

scenarioTest('a bare client name recovers natively, then its prefixed retry is held, released and replayed verbatim', async () => {
  const run = new Run('bare-retry', false)
  await run.run(async () => {
    run.drv.opts.tools = [{ type: 'function', name: 'send_message', description: 'Send a message.', parameters: { type: 'object' } }]
    run.fake.reply(
      { blocks: [bare('toolu_bare', 'send_message', { text: 'hi' })] },
      { blocks: [call('toolu_retry', 'send_message', { text: 'hi' })] },
      { blocks: [text('delivered')] },
    )
    const held = await run.send([user('send hi')])
    assertEquals(held.status, 'completed', JSON.stringify(held.response.error))
    assertEquals(run.drv.calls(held).map((c) => [c.call_id, c.name]), [['toolu_retry', 'send_message']])
    assert(!held.events.some((e) => e.item?.call_id === 'toolu_bare'), 'native call never enters the client stream')
    await run.tg.waitEvent('hold', (d) => d.call === 'toolu_retry')
    assertEquals(run.fake.main().length, 2, 'the real tool is held, not inferred past')
    const rec = (await recordOf(held))!
    assertEquals(rec.nativeCalls, ['toolu_bare'])
    assertStringIncludes(rec.entries.join('\n'), '"name":"send_message"')
    assertStringIncludes(rec.entries.join('\n'), 'No such tool available: send_message')
    const finished = await run.send([output('toolu_retry', 'CLIENT-DELIVERED')])
    assertEquals(run.drv.text(finished), 'delivered')
    const delivered = results(run.fake.main()[2].body)
    assertEquals(delivered.find((b: Json) => b.tool_use_id === 'toolu_bare').is_error, true)
    assertStringIncludes(JSON.stringify(delivered.find((b: Json) => b.tool_use_id === 'toolu_retry')), 'CLIENT-DELIVERED')
    await run.disrupt('restart-lost-store')
    run.fake.reply({ blocks: [text('later')] })
    const rebuilt = await run.send([user('next')])
    assertEquals(rebuilt.response.x_gateway.records, 2)
    assertEquals(rebuilt.response.x_gateway.synthesized_groups, 0)
    assertPrefix(run.fake.main()[2], run.fake.main()[3])
    assertOneUserId(run.fake.main())
  })
})

scenarioTest('unknown bare and MCP names continue to a final answer without any client tool output, then rebuild', async () => {
  const run = new Run('native-unknowns', false)
  await run.run(async () => {
    run.fake.reply({ blocks: [bare('toolu_unknown', 'not_available'), call('toolu_mcp_unknown', 'not_available', {})] }, { blocks: [text('recovered')] })
    const r = await run.send([user('go')])
    assertEquals(r.status, 'completed', JSON.stringify(r.response.error))
    assertEquals(run.drv.calls(r), [])
    assertEquals(run.drv.text(r), 'recovered')
    assertEquals(run.tg.events('hold'), [])
    const rs = results(run.fake.main()[1].body)
    assertEquals(rs.map((b: Json) => b.is_error), [true, true])
    assertStringIncludes(rs[0].content, 'No such tool available: not_available')
    assertStringIncludes(rs[1].content, 'No such tool available: mcp__fn__not_available')
    await run.disrupt('restart-lost-store')
    run.fake.reply({ blocks: [text('next')] })
    const rebuilt = await run.send([user('next')])
    assertEquals(rebuilt.response.x_gateway.records, 1)
    assertEquals(rebuilt.response.x_gateway.synthesized_groups, 0)
    assertPrefix(run.fake.main()[1], run.fake.main()[2])
  })
})

for (const nativeFirst of [false, true]) {
  scenarioTest(
    `parallel prefixed and bare calls hold only the client call and preserve native errors through rebuild (bare ${nativeFirst ? 'first' : 'last'})`,
    async () => {
      const run = new Run(`mixed-bare-${nativeFirst}`, false)
      await run.run(async () => {
        const blocks = [call('toolu_client', 'echo', { text: 'first' }), bare('toolu_native', 'echo', { text: 'second' })]
        if (nativeFirst) blocks.reverse()
        run.fake.reply({ blocks }, { blocks: [call('toolu_retry', 'echo', { text: 'second' })] }, { blocks: [text('done')] })
        const r = await run.send([user('run both')])
        assertEquals(run.drv.calls(r).map((c) => c.call_id), ['toolu_client'])
        await run.tg.waitEvent('hold')
        await run.disrupt('restart-lost-store') // native call after the hold may not yet have its result
        const retry = await run.send([output('toolu_client', 'FIRST-OUTPUT')])
        assertEquals(retry.response.x_gateway.records, 1)
        assertEquals(retry.response.x_gateway.synthesized_groups, 0)
        assertEquals(run.drv.calls(retry).map((c) => c.call_id), ['toolu_retry'])
        const rs = results(run.fake.main()[1].body)
        assertEquals(rs.map((b: Json) => b.tool_use_id), blocks.map((b: Json) => b.id))
        assertStringIncludes(rs.find((b: Json) => b.tool_use_id === 'toolu_native').content, 'No such tool available: echo')
        const done = await run.send([output('toolu_retry', 'SECOND-OUTPUT')])
        assertEquals(run.drv.text(done), 'done')
        await run.disrupt('restart-lost-store')
        run.fake.reply({ blocks: [text('later')] })
        const later = await run.send([user('next')])
        assertEquals(later.response.x_gateway.records, 3)
        assertEquals(later.response.x_gateway.synthesized_groups, 0)
        assertPrefix(run.fake.main()[2], run.fake.main()[3])
      })
    },
  )
}

for (const name of ['mcp__fn__echo', 'echo', 'not_available']) {
  Deno.test(`malformed tool_use arguments stay a typed failure, including hidden native calls (${name})`, async () => {
    const run = new Run(`malformed-tool-${name}`, false)
    await run.run(async () => {
      run.fake.reply({ blocks: [bare('toolu_bad', name, ['not an object'])] })
      const r = await run.send([user('go')])
      assertEquals([r.status, r.response.error?.code], ['failed', 'malformed_model_message'])
    })
  })
}

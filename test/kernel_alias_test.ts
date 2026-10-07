import { assert, assertEquals } from '@std/assert'
import { type InItem } from '../src/api/request.ts'
import { matchRecordItems, remapItems } from '../src/call_ids.ts'
import { digestItems, type ProviderRecord } from '../src/records.ts'
import { call, type Json, text } from './fake.ts'
import { assertPrefix, user } from './harness.ts'
import { IMAGE } from './images.ts'
import { committedCallId, kernelBody } from './kernel_shapes.ts'
import { MODEL, Run, TOOLS } from './scenario.ts'

const b = () => kernelBody({ model: MODEL, instructions: 'You are helpful.', tools: TOOLS, input: [user('Hello')] })
const rename = (input: Json[]) => input.map((it) => it.call_id ? { ...it, call_id: committedCallId(it.call_id) } : it)
const output = (id: string, value: string) => ({ type: 'function_call_output', call_id: id, output: value })

// Sol's two-tool/image/forced-full regression, followed by another aliased tool round.
for (const lostStore of [false, true]) {
  Deno.test(`kernel UUID full replay preserves two records, image bytes and further tool delivery (${lostStore ? 'lost store' : 'forced compact'})`, async () => {
    const run = new Run(`kernel-id-${lostStore}`, false, { transport: 'websocket' })
    await run.run(async () => {
      const body = b()
      body.input[1] = { role: 'user', content: [{ type: 'input_text', text: 'Hello' }, { ...IMAGE, detail: 'original' }] }
      let ws = run.tg.websocket()
      run.fake.reply({ blocks: [call('toolu_alias1', 'echo', { text: 'x' }), call('toolu_alias2', 'read', { name: 'y' })] })
      const first = await ws.send(body)
      const outputs = [output('toolu_alias1', 'X'), output('toolu_alias2', 'Y')]
      run.fake.reply({ blocks: [text('done')] })
      const second = await ws.send({ ...body, previous_response_id: first.response.id, input: outputs })
      const history = [...body.input, ...first.response.output, ...outputs, ...second.response.output]
      if (lostStore) {
        await run.disrupt('restart-lost-store')
        ws = run.tg.websocket()
      }
      run.fake.reply({ blocks: [call('toolu_alias3', 'echo', { text: 'next' })] })
      const third = await ws.send({ ...body, tool_choice: { type: 'function', name: 'echo' }, input: [...rename(history), user('compact now')] })
      assertEquals([third.status, third.response.x_gateway.records, third.response.x_gateway.synthesized_groups], ['completed', 2, 0])
      assertPrefix(run.fake.main()[1], run.fake.main()[2])
      const record = run.tg.gw.store.get(third.response.id)!
      assert(record.callAliases!.some(([client, provider]) => client === committedCallId('toolu_alias1') && provider === 'toolu_alias1'))
      await run.disrupt('restart')
      ws = run.tg.websocket()
      // A full create after reconnect contains the kernel UUID for the new call and its result too.
      run.fake.reply({ blocks: [text('next done')] })
      const fourth = await ws.send({ ...body, input: rename([...history, user('compact now'), ...third.response.output, output('toolu_alias3', 'NEXT')]) })
      assertEquals([fourth.status, fourth.response.x_gateway.records, fourth.response.x_gateway.synthesized_groups], ['completed', 3, 0])
      assertPrefix(run.fake.main()[2], run.fake.main()[3])
      const last = run.fake.main()[3].body.messages
      const results = last.flatMap((m: Json) => Array.isArray(m.content) ? m.content : []).filter((p: Json) => p.type === 'tool_result')
      assert(results.some((p: Json) => p.tool_use_id === 'toolu_alias3' && JSON.stringify(p.content).includes('NEXT')))
      assert(!JSON.stringify(last).includes(committedCallId('toolu_alias3')))
      const aliases = run.tg.gw.store.get(fourth.response.id)!.callAliases!
      assert(aliases.some(([client, provider]) => client === committedCallId('toolu_alias3') && provider === 'toolu_alias3'))
      await run.disrupt('restart')
      ws = run.tg.websocket()
      run.fake.reply({ blocks: [text('continued')] })
      const fifth = await ws.send({ ...body, previous_response_id: fourth.response.id, input: [user('continue after another restart')] })
      assertEquals(fifth.status, 'completed')
      assertPrefix(run.fake.main()[3], run.fake.main()[4])
      assertEquals(run.tg.gw.store.get(fifth.response.id)!.callAliases, aliases)
    })
  })
}

async function sample() {
  const items: InItem[] = [
    { kind: 'message', role: 'user', parts: [{ type: 'text', text: 'same' }, { type: 'image', mediaType: 'image/png', data: 'AA==' }] },
    { kind: 'function_call', callId: 'provider-a', name: 'echo', arguments: '{"text":"a"}' },
    { kind: 'function_call', callId: 'provider-b', name: 'read', arguments: '{"name":"b"}' },
    { kind: 'function_call_output', callId: 'provider-a', parts: [{ type: 'text', text: 'A' }] },
    { kind: 'function_call_output', callId: 'provider-b', parts: [{ type: 'text', text: 'B' }] },
  ]
  const record = {
    digest: await digestItems(items),
    entries: items.filter((it) => it.kind === 'function_call').map((it) =>
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: it.callId }] } })
    ),
  } as ProviderRecord
  const aliases: [string, string][] = [['uuid-a', 'provider-a'], ['uuid-b', 'provider-b']]
  const client = remapItems(items, aliases.map(([a, p]) => [p, a]))
  return { items, client, record, aliases }
}

Deno.test('record matching permits only a consistent bijection, including references across record boundaries', async () => {
  const { items, client, record, aliases } = await sample()
  assertEquals(await matchRecordItems(client, record, []), aliases)
  assertEquals(remapItems(client, aliases), items)
  for (
    const bad of [
      client.map((it) => it.kind === 'function_call' || it.kind === 'function_call_output' ? { ...it, callId: 'one-client-id' } : it),
      client.map((it) => it.kind === 'function_call_output' && it.callId === 'uuid-a' ? { ...it, callId: 'different-client-id' } : it),
      client.map((it) => it.kind === 'function_call_output' && it.callId === 'uuid-a' ? { ...it, callId: 'provider-a' } : it),
    ]
  ) assertEquals(await matchRecordItems(bad, record, []), null)
  assertEquals(await matchRecordItems(client, record, [['uuid-a', 'other-provider']]), null)
  assertEquals(await matchRecordItems(client, record, [['old-client', 'provider-a']]), null)
})

Deno.test('record matching never ignores changes to names, argument bytes, output bytes, text, images or order', async () => {
  const { client, record } = await sample()
  const changes = [
    client.map((it) => it.kind === 'function_call' ? { ...it, name: 'changed' } : it),
    client.map((it) => it.kind === 'function_call' ? { ...it, arguments: '{ "text": "a" }' } : it),
    client.map((it) => it.kind === 'function_call_output' ? { ...it, parts: [{ type: 'text' as const, text: 'changed' }] } : it),
    client.map((it) => it.kind === 'message' ? { ...it, parts: [{ type: 'text' as const, text: 'changed' }] } : it),
    client.map((it) =>
      it.kind === 'message' ? { ...it, parts: [{ type: 'text' as const, text: 'same' }, { type: 'image' as const, mediaType: 'image/png', data: 'AQ==' }] } : it
    ),
    [client[0], client[2], client[1], ...client.slice(3)],
  ]
  for (const changed of changes) assertEquals(await matchRecordItems(changed, record, []), null)
})

Deno.test('a later edited group does not partially reuse an aliased record prefix', async () => {
  const run = new Run('alias-edit', false, { transport: 'websocket' })
  await run.run(async () => {
    const body = b(), ws = run.tg.websocket()
    run.fake.reply({ blocks: [call('toolu_edit', 'echo', { text: 'x' })] }, { blocks: [text('done')] })
    const first = await ws.send(body)
    const outputs = [output('toolu_edit', 'X')]
    const second = await ws.send({ ...body, previous_response_id: first.response.id, input: outputs })
    run.fake.reply({ blocks: [text('changed history')] })
    const changed = await ws.send({
      ...body,
      input: [...rename([...body.input, ...first.response.output, output('toolu_edit', 'EDITED'), ...second.response.output]), user('next')],
    })
    assertEquals([changed.response.x_gateway.records, changed.response.x_gateway.synthesized_groups], [0, 2])
    const editedHistory = [...rename([...body.input, ...first.response.output, output('toolu_edit', 'EDITED'), ...second.response.output]), user('next')]
    run.fake.reply({ blocks: [text('warm again')] })
    const warm = await ws.send({ ...body, input: [...editedHistory, ...changed.response.output, user('again')] })
    assertEquals([warm.response.x_gateway.records, warm.response.x_gateway.synthesized_groups], [1, 0])
    assertPrefix(run.fake.main()[2], run.fake.main()[3])
  })
})

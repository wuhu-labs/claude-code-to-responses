import { assert, assertEquals, assertExists, assertNotEquals } from '@std/assert'
import { decodeRecord, encodeRecord } from '../src/records.ts'
import { replayLog } from '../src/replay.ts'
import { call, type Json, text } from './fake.ts'
import { user } from './harness.ts'
import { noisePng } from './images.ts'
import { INSTRUCTIONS, MODEL, Run, TOOLS } from './scenario.ts'

const base = { model: MODEL, instructions: INSTRUCTIONS, tools: TOOLS }

Deno.test('slim native-image records recover exact bytes from sidecars, legacy fat records, and one-time full-loss regeneration', async () => {
  const run = new Run('slim-native-image', false)
  await run.run(async () => {
    const png = await noisePng()
    const body = {
      ...base,
      input: [{
        role: 'user',
        content: [{ type: 'input_text', text: 'Inspect native image.' }, { type: 'input_image', image_url: `data:image/png;base64,${png}` }],
      }],
    }
    let ws = run.tg.websocket()
    run.fake.reply({ blocks: [text('saw image')], usage: { input_tokens: 50_000 } })
    const first = await ws.send(body)
    const opaque = first.response.output.at(-1).encrypted_content
    assert(opaque.length < 16 * 1024)
    const record = await decodeRecord(opaque)
    assertExists(record)
    assert(record.replay?.length)
    assert(!JSON.stringify(record).includes(png.slice(0, 100)))
    const fullLog = replayLog(record, run.tg.gw.store)
    const nativeImage = fullLog.flatMap((l) => JSON.parse(l).message?.content ?? []).find((b: Json) => b.type === 'image')
    assertExists(nativeImage)
    assertEquals(nativeImage.source.media_type, 'image/jpeg', 'pinned SDK actually re-encodes this PNG')
    const { replay: _, ...old } = record
    const legacyOpaque = await encodeRecord({ ...old, entries: fullLog })
    const fullBody = { ...base, input: [...body.input, ...first.response.output, user('again')] }
    run.fake.reply({ blocks: [text('continued')], usage: { input_tokens: 50_000 } })
    await ws.send({ ...base, previous_response_id: first.response.id, input: 'again' })
    const live = run.fake.main()[1].raw
    await run.tg.evictAll()
    Deno.removeSync(run.tg.gw.store.dir, { recursive: true })
    Deno.mkdirSync(run.tg.gw.store.dir)
    run.fake.reply({ blocks: [text('continued')], usage: { input_tokens: 50_000 } })
    const retained = await ws.send(fullBody)
    assertEquals([retained.status, retained.response.x_gateway.records], ['completed', 1])
    assertEquals(run.fake.main()[2].raw, live, 'loss of response store alone retains exact native bytes via content sidecars')
    await run.disrupt('restart-lost-store')
    ws = run.tg.websocket()
    run.fake.reply({ blocks: [text('continued')], usage: { input_tokens: 50_000 } })
    const legacyBody = { ...fullBody, input: fullBody.input.map((i: Json) => i.encrypted_content === opaque ? { ...i, encrypted_content: legacyOpaque } : i) }
    assertEquals((await ws.send(legacyBody)).status, 'completed')
    assertEquals(run.fake.main()[3].raw, live, 'older fat records remain byte-exact without any sidecar')
    await run.disrupt('restart-lost-store')
    ws = run.tg.websocket()
    run.fake.reply({ blocks: [text('continued')], usage: { input_tokens: 50_000 } })
    assertEquals((await ws.send(fullBody)).status, 'completed')
    const regenerated = run.fake.main()[4]
    assertNotEquals(regenerated.raw, live)
    const image = regenerated.body.messages.flatMap((m: Json) => m.content).find((b: Json) => b.type === 'image')
    assertEquals(image.source, { type: 'base64', media_type: 'image/png', data: png })
    await run.disrupt('restart')
    ws = run.tg.websocket()
    run.fake.reply({ blocks: [text('continued')], usage: { input_tokens: 50_000 } })
    assertEquals((await ws.send(fullBody)).status, 'completed')
    assertEquals(run.fake.main()[5].raw, regenerated.raw, 'regeneration aliases retain the one-time cache break across restart')
  })
})

Deno.test('slim synthesized tool history retains framing and does not compound records on full creates', async () => {
  const run = new Run('slim-tool-history', false)
  await run.run(async () => {
    let ws = run.tg.websocket()
    const input = [
      user('historical request'),
      { type: 'function_call', call_id: 'client-old', name: 'echo', arguments: '{"text":"old"}' },
      { type: 'function_call_output', call_id: 'client-old', output: 'OLD' },
      { role: 'assistant', content: 'historical answer' },
      user('now'),
    ]
    run.fake.reply({ blocks: [call('toolu_new', 'echo', { text: 'new' })] })
    const first = await ws.send({ ...base, input })
    assertEquals(first.status, 'completed')
    assert(first.response.output.at(-1).encrypted_content.length < 16 * 1024)
    const outputs = [{ type: 'function_call_output', call_id: 'toolu_new', output: 'NEW' }]
    run.fake.reply({ blocks: [text('done')] })
    const second = await ws.send({ ...base, previous_response_id: first.response.id, input: outputs })
    run.fake.reply({ blocks: [text('next done')] })
    await ws.send({ ...base, previous_response_id: second.response.id, input: 'next' })
    const live = run.fake.main()[2].raw
    await run.disrupt('restart-lost-store')
    ws = run.tg.websocket()
    run.fake.reply({ blocks: [text('next done')] })
    const recovered = await ws.send({ ...base, input: [...input, ...first.response.output, ...outputs, ...second.response.output, user('next')] })
    assertEquals([recovered.status, recovered.response.x_gateway.records, recovered.response.x_gateway.synthesized_groups], ['completed', 2, 0])
    assertEquals(run.fake.main()[3].raw, live)
    assert(recovered.response.output.at(-1).encrypted_content.length < 16 * 1024)
  })
})

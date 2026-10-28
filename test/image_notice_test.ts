import { replayLog } from '../src/replay.ts'
// Image notices use the queue without eviction, then survive every record-based rebuild without losing image bytes.
import { assert, assertEquals, assertExists } from '@std/assert'
import { decodeRecord } from '../src/records.ts'
import { call, type Json, text } from './fake.ts'
import { assertOneUserId, assertPrefix, output, user } from './harness.ts'
import { IMAGE, IMAGE_BLOCK, noisePng } from './images.ts'
import { Run } from './scenario.ts'

for (const path of ['live', 'evicted', 'history'] as const) {
  Deno.test(`an image notice resumes a ${path} hold with real images; idle eviction and lost-store rebuild repeat its bytes`, async () => {
    const run = new Run(`image-notice-${path}`, false)
    await run.run(async () => {
      run.fake.reply({ blocks: [call('toolu_img1', 'echo', { text: 'slow' }), call('toolu_img2', 'read', { name: 'big' })] })
      await run.send([user('two tools')])
      await run.tg.waitEvent('hold', (d) => d.call === 'toolu_img1')
      const before = run.fake.main()[0]
      if (path === 'evicted') await run.disrupt('hold')
      if (path === 'history') await run.disrupt('restart-lost-store')
      run.fake.reply({ blocks: [text('saw the images')] })
      const notice = { role: 'user', content: [{ type: 'input_text', text: 'NOTICE before image' }, IMAGE, { type: 'input_text', text: 'after image' }] }
      // Multiple message items (including image-only and blank ones) become one user log entry after all results.
      const r = await run.send([output('toolu_img2', 'BIG'), notice, output('toolu_img1', 'ECHO'), user('   '), { role: 'user', content: [IMAGE] }])
      assertEquals(r.status, 'completed', JSON.stringify(r.response.error))
      if (path !== 'live') assertEquals(r.response.x_gateway.resume, 'interrupted_turn')
      if (path === 'live') {
        assertEquals(r.response.x_gateway.path, 'live')
        assertEquals(run.tg.events('kill').length, 0)
        assertEquals(run.tg.events('spawn').length, 1)
      }
      assertEquals(run.tg.events('notice').length, path === 'live' ? 1 : 0)
      const after = run.fake.main()[1]
      assertPrefix(before, { ...after, body: { ...after.body, messages: after.body.messages.slice(0, before.body.messages.length) } })
      const tail = after.body.messages.slice(before.body.messages.length)
      assertEquals(tail.length, 2)
      assertEquals(tail[0].role, 'assistant')
      assertEquals(tail[0].content.map((b: Json) => b.id), ['toolu_img1', 'toolu_img2'])
      const content = tail[1].content
      assertEquals(content.slice(0, 2).map((b: Json) => [b.tool_use_id, b.content[0].text]), [['toolu_img1', 'ECHO'], ['toolu_img2', 'BIG']])
      assertEquals(content.filter((b: Json) => b.type === 'image').map((b: Json) => b.source), [IMAGE_BLOCK.source, IMAGE_BLOCK.source])
      assert(JSON.stringify(content).includes('The user sent a new message while you were working:'))
      assert(JSON.stringify(content).includes('NOTICE before image'))
      assert(JSON.stringify(content).includes('after image'))
      const rec = await decodeRecord(r.response.output.at(-1).encrypted_content)
      assertExists(rec)
      const noticeEntries = replayLog(rec, run.tg.gw.store).filter((e) => e.includes('NOTICE before image'))
      assertEquals(noticeEntries.length, 1)
      assertEquals(JSON.parse(noticeEntries[0]).attachment.type, 'queued_command')
      await run.disrupt('idle')
      run.fake.reply({ blocks: [text('after idle')] })
      await run.turn('next')
      await run.disrupt('restart-lost-store')
      run.fake.reply({ blocks: [text('after history rebuild')] })
      const rebuilt = await run.turn('last')
      assertEquals(rebuilt.response.x_gateway.path, 'history')
      assertEquals(rebuilt.response.x_gateway.synthesized_groups, 0)
      const requests = run.fake.main()
      assertPrefix(after, requests[2])
      assertPrefix(requests[2], requests[3])
      assertOneUserId(requests)
      // The exact appended log line remains in the store after the lost-state recovery.
      const chain = run.tg.gw.store.chain(rebuilt.response.id)!
      assert(chain.flatMap((r) => replayLog(r, run.tg.gw.store)).includes(noticeEntries[0]))
    })
  })
}

Deno.test('bad-format, malformed-base64 and oversized image notices are typed 400s before eviction or releasing outputs', async () => {
  const run = new Run('image-errors', false)
  await run.run(async () => {
    run.fake.reply({ blocks: [call('toolu_badimg', 'echo', { text: 'x' })] })
    await run.send([user('hold')])
    await run.tg.waitEvent('hold')
    const errors = [
      ['data:image/bmp;base64,Qk0=', 'unsupported'],
      ['data:image/svg+xml;base64,PHN2Zy8+', 'unsupported'],
      ['https://example.com/image.png', 'unsupported'],
      ['data:image/png;base64,====', 'invalid_request'],
      ['data:image/png;base64,', 'invalid_request'],
      ['data:image/jpeg;base64,not-base64!', 'invalid_request'],
      ['data:image/gif;base64,AA A', 'invalid_request'],
      ['data:image/webp;base64,AA\nAA', 'invalid_request'],
      ['data:image/png;base64,A', 'invalid_request'],
      ['data:image/png;base64,AAA===', 'invalid_request'],
    ]
    for (const [image_url, code] of errors) {
      const response = await fetch(`${run.tg.url}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          instructions: run.drv.opts.instructions,
          tools: run.drv.opts.tools,
          model: run.drv.opts.model,
          previous_response_id: run.drv.prevId,
          stream: true,
          input: [output('toolu_badimg', 'RESULT'), { role: 'user', content: [{ type: 'input_image', image_url }] }],
        }),
      })
      assertEquals(response.status, 400)
      const body = await response.json()
      assertEquals(body.error.type, 'invalid_request_error')
      assertEquals(body.error.code, code)
      assertEquals(body.error.param, 'input[1].content[0].image_url')
      assertEquals(run.tg.events('kill').length, 0)
      assertEquals(run.fake.main().length, 1)
    }
    run.fake.reply({ blocks: [text('good retry')] })
    assertEquals((await run.send([output('toolu_badimg', 'RESULT'), { role: 'user', content: [IMAGE] }])).status, 'completed')
  })
})

for (const path of ['live', 'lost-store'] as const) {
  Deno.test(`incomplete image-notice outputs in ${path} client history are rejected before eviction or store mutation`, async () => {
    const { alive } = await import('./harness.ts')
    const run = new Run(`image-history-preflight-${path}`, false, { mode: 'history' })
    await run.run(async () => {
      run.fake.reply({ blocks: [call('toolu_preflight1', 'echo', { text: 'x' }), call('toolu_preflight2', 'read', { name: 'y' })] })
      await run.send([user('two tools')])
      await run.tg.waitEvent('hold', (d) => d.call === 'toolu_preflight1')
      const pid = run.tg.events('spawn')[0].data.pid
      if (path === 'lost-store') await run.disrupt('restart-lost-store')
      const notice = { role: 'user', content: [{ type: 'input_text', text: 'valid image notice' }, IMAGE] }
      const snapshot = () =>
        [run.tg.gw.store.dir, run.tg.gw.store.tailDir].map((dir) =>
          [...Deno.readDirSync(dir)].map((e) => [e.name, Deno.readTextFileSync(`${dir}/${e.name}`)]).sort((a, b) => a[0].localeCompare(b[0]))
        )
      const before = snapshot(), kills = run.tg.events('kill').length, spawns = run.tg.events('spawn').length
      const response = await fetch(`${run.tg.url}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          instructions: run.drv.opts.instructions,
          tools: run.drv.opts.tools,
          model: run.drv.opts.model,
          stream: true,
          input: [...run.drv.history, output('toolu_preflight1', 'ONE'), notice],
        }),
      })
      assertEquals(response.status, 400)
      const body = await response.json()
      assertEquals(body.error.type, 'invalid_request_error')
      assertEquals(body.error.code, 'missing_tool_output')
      assertEquals(run.tg.events('kill').length, kills)
      assertEquals(run.tg.events('spawn').length, spawns)
      assertEquals(snapshot(), before, 'no imported provider records or stored tails on a rejected delivery')
      assertEquals(run.fake.main().length, 1)
      if (path === 'live') assert(alive(pid), 'the original held process is still alive')
      run.fake.reply({ blocks: [text('corrected retry')] })
      const corrected = await run.send([output('toolu_preflight1', 'ONE'), output('toolu_preflight2', 'TWO'), notice])
      assertEquals(corrected.status, 'completed')
      assertEquals(run.drv.text(corrected), 'corrected retry')
      assertEquals(corrected.response.x_gateway.path, 'history')
      assertEquals(run.fake.main().at(-1)!.body.messages.at(-1).content.find((b: Json) => b.type === 'image').source, IMAGE_BLOCK.source)
    })
  })
}

for (const [path, size] of [['live', 'small'], ['evicted', 'small'], ['lost-store', 'small'], ['live', 'large'], ['evicted', 'large']] as const) {
  Deno.test(`${size} images inside tool outputs on a ${path} hold survive idle eviction and lost-store record replay`, async () => {
    const image = size === 'small' ? IMAGE : { type: 'input_image', image_url: `data:image/png;base64,${await noisePng()}` }
    const imageBlock = size === 'small'
      ? IMAGE_BLOCK
      : { type: 'image', source: { type: 'base64', media_type: 'image/png', data: image.image_url.split(',')[1] } }
    if (size === 'large') assertEquals(imageBlock.source.data.length, 810940)
    const run = new Run(`tool-output-image-${path}-${size}`, false)
    await run.run(async () => {
      if (size === 'large') run.drv.opts.model += '[1m]' // fake count_tokens counts encoded characters as text
      run.fake.reply({ blocks: [call('toolu_outputimg', 'echo', { text: 'image' })] })
      await run.send([{ role: 'user', content: [IMAGE, { type: 'input_text', text: 'tool image' }] }])
      assertEquals(run.fake.main()[0].body.messages[0].content.find((b: Json) => b.type === 'image').source, IMAGE_BLOCK.source)
      await run.tg.waitEvent('hold')
      if (path === 'evicted') await run.disrupt('hold')
      if (path === 'lost-store') await run.disrupt('restart-lost-store')
      const configDir = `${run.d.stateDir}/claude/config`
      run.fake.reply({ blocks: [text('saw tool image')] })
      const completed = await run.send([{
        type: 'function_call_output',
        call_id: 'toolu_outputimg',
        output: size === 'large' ? [image] : [{ type: 'input_text', text: 'before tool image' }, image, { type: 'input_text', text: 'after tool image' }],
      }])
      assertEquals(completed.status, 'completed')
      const direct = run.fake.main()[1]
      const result = direct.body.messages.at(-1).content.find((b: Json) => b.type === 'tool_result')
      const actualImages = result.content.filter((b: Json) => b.type === 'image')
      assertEquals(actualImages.length, 1)
      if (size === 'small' || path !== 'live') assertEquals(actualImages, [imageBlock])
      else {
        const source = actualImages[0].source
        assert(['image/png', 'image/jpeg'].includes(source.media_type))
        assert(source.data.startsWith(source.media_type === 'image/jpeg' ? '/9j/' : 'iVBOR'))
      }
      assertEquals(
        result.content.filter((b: Json) => b.type === 'text' && !b.text.startsWith('[Image: source: ')),
        size === 'large' ? [] : [
          { type: 'text', text: 'before tool image' },
          { type: 'text', text: 'after tool image' },
        ],
      )
      if (path === 'live') {
        assertEquals(result.content.length, size === 'large' ? 2 : 4)
        const label = result.content.find((b: Json) => b.type === 'text' && b.text.startsWith('[Image: source: '))
        assertEquals(label.type, 'text')
        assert(label.text.startsWith(`[Image: source: ${configDir}/projects/`))
        assert(label.text.includes('/tool-results/mcp-fn-blob-'))
        assert(/\.(png|jpeg|jpg)\]$/.test(label.text))
      } else {
        assertEquals(result.content.length, size === 'large' ? 1 : 3, 'appended tool-result images have no nested source label')
      }
      const record = await decodeRecord(completed.response.output.at(-1).encrypted_content)
      assertExists(record)
      const imageResults = replayLog(record, run.tg.gw.store).flatMap((entry) => JSON.parse(entry).message?.content ?? [])
        .filter((b: Json) => b.type === 'tool_result' && b.tool_use_id === 'toolu_outputimg')
      assertEquals(imageResults.length, 1)
      assertEquals(imageResults[0].content, result.content, 'saved tool result includes any native MCP source label')
      await run.disrupt('idle')
      run.fake.reply({ blocks: [text('after idle')] })
      await run.turn('next')
      const sameConfig = run.fake.main()[2]
      assertPrefix(direct, sameConfig)
      await run.disrupt('restart-lost-store')
      assert(configDir !== `${run.d.stateDir}/claude/config`)
      run.fake.reply({ blocks: [text('after lost store')] })
      const rebuilt = await run.turn('last')
      assertEquals(rebuilt.response.x_gateway.path, 'history')
      assertEquals(rebuilt.response.x_gateway.synthesized_groups, 0)
      const recovered = run.fake.main()[3]
      const rebuiltResult = recovered.body.messages.flatMap((m: Json) => m.content)
        .find((b: Json) => b.type === 'tool_result' && b.tool_use_id === 'toolu_outputimg')
      const regenerated = result.content.map((part: Json) =>
        part.type === 'image' && size === 'large' && path === 'live'
          ? { ...part, source: { type: 'base64', media_type: 'image/png', data: imageBlock.source.data } }
          : part
      )
      assertEquals(rebuiltResult.content, regenerated, 'full loss retains labels and regenerates native image payloads from original input')
      if (!(size === 'large' && path === 'live')) assertPrefix(sameConfig, recovered)
      assertOneUserId(run.fake.main())
    })
  })
}

import { queueWrapper } from './queue.ts'
import { replayLog } from '../src/replay.ts'
import { scenarioTest } from './scenario.ts'
// Gateway core on the fake endpoint: held calls, message_stop, notices, records, usage, eviction and restart bytes.
import { assert, assertEquals, assertExists, assertStringIncludes } from '@std/assert'
import { decodeRecord } from '../src/records.ts'
import { call, type Json, text, think } from './fake.ts'
import { assertOneUserId, assertPrefix, assertSameRequests, output, user } from './harness.ts'
import { Run } from './scenario.ts'

function recordOf(r: { response: Json }) {
  const items = r.response.output.filter((o: Json) => o.type === 'reasoning' && o.encrypted_content?.startsWith('cc2r.record.v1.'))
  assertEquals(items.length, 1, 'one provider record per response')
  return decodeRecord(items[0].encrypted_content)
}

scenarioTest('parallel calls are held until the outputs come, in any order; the response ends at message_stop', async () => {
  const run = new Run('parallel', false)
  await run.run(async () => {
    // the fake streams 400 ms between blocks: Claude Code calls the first tool long before the message ends
    run.fake.reply({
      blocks: [think('plan'), call('toolu_a', 'echo', { text: 'a' }), call('toolu_b', 'read', { name: 'b' }), call('toolu_c', 'echo', { text: 'c' })],
      gapMs: 400,
    })
    const r1 = await run.send([user('do three things')])
    assertEquals(r1.status, 'completed')
    const calls = run.drv.calls(r1)
    assertEquals(calls.map((c: Json) => c.call_id), ['toolu_a', 'toolu_b', 'toolu_c'])
    assertEquals(calls.map((c: Json) => c.name), ['echo', 'read', 'echo'])
    assertEquals(JSON.parse(calls[1].arguments), { name: 'b' })
    // the first call arrived while the message was still streaming, and only it: Claude Code calls MCP one at a time
    const holds = run.tg.events('hold')
    assertEquals(holds.map((h) => h.data.call), ['toolu_a'])
    const completed = run.tg.events('completed')[0]
    assert(holds[0].at < completed.at - 500, 'first MCP call arrived before message_stop')
    const rec = await recordOf(r1)
    assertExists(rec)
    assertEquals(rec.end, 'calls')
    assertEquals(rec.calls.map((c) => c.id), ['toolu_a', 'toolu_b', 'toolu_c'])

    // outputs in reverse order, plus a notice: it is enqueued before any call is released
    run.fake.reply({ blocks: [text('all done')] })
    const r2 = await run.send([output('toolu_c', 'C-OUT'), output('toolu_b', 'B-OUT'), user('NOTICE: a new message arrived'), output('toolu_a', 'A-OUT')])
    assertEquals(r2.status, 'completed')
    assertEquals(run.drv.text(r2), 'all done')
    const req = run.fake.main().at(-1)!.body
    const msgs = req.messages
    const results = msgs[msgs.length - 2]
    assertEquals(results.role, 'user')
    assertEquals(results.content.map((b: Json) => [b.tool_use_id, b.content[0].text]), [['toolu_a', 'A-OUT'], ['toolu_b', 'B-OUT'], ['toolu_c', 'C-OUT']])
    const notice = msgs[msgs.length - 1]
    assertEquals(notice.role, 'system')
    assertEquals(notice.content[0].text, queueWrapper('NOTICE: a new message arrived'))
    assertEquals(run.tg.events('notice').map((n) => n.data.via), ['queue'])
    assertEquals(run.fake.main().length, 2, 'exactly one model request per tool round')
  })
})

scenarioTest('usage maps cache reads into cached_tokens and keeps the raw numbers', async () => {
  const run = new Run('usage', false)
  await run.run(async () => {
    run.fake.reply({ blocks: [text('hi')], usage: { input_tokens: 7, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50, output_tokens: 3 } })
    const r = await run.send([user('hello')])
    assertEquals(r.response.usage.input_tokens, 1057)
    assertEquals(r.response.usage.input_tokens_details.cached_tokens, 1000)
    assertEquals(r.response.usage.output_tokens, 3)
    assertEquals(r.response.usage.anthropic, { input_tokens: 7, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50, output_tokens: 3 })
    // the standard event sequence of a text response
    const types = r.events.map((e) => e.type)
    assertEquals(types.slice(0, 2), ['response.created', 'response.in_progress'])
    for (
      const t of [
        'response.output_item.added',
        'response.content_part.added',
        'response.output_text.delta',
        'response.output_text.done',
        'response.content_part.done',
        'response.output_item.done',
      ]
    ) {
      assert(types.includes(t), t)
    }
    assertEquals(types.at(-1), 'response.completed')
    assertEquals(r.events.map((e) => e.sequence_number), r.events.map((_, i) => i))
  })
})

scenarioTest('a provider record is every log entry since the previous response, verbatim', async () => {
  const run = new Run('records', false)
  await run.run(async () => {
    run.fake.reply({ blocks: [text('one')] })
    const r1 = await run.send([user('first')])
    run.fake.reply({ blocks: [call('toolu_r', 'echo', { text: 'x' })] }, { blocks: [text('two')] })
    const r2 = await run.send([user('second')])
    const r3 = await run.send([output('toolu_r', 'X')])
    const recs = [await recordOf(r1), await recordOf(r2), await recordOf(r3)]
    assertEquals(recs.map((r) => r!.prev), [null, r1.response.id, r2.response.id])
    // the store holds the same records
    for (const r of recs) assertEquals(run.tg.gw.store.get(r!.id), r)
    // once the process is gone, its whole log is the records: the end-of-turn entries are in the last one, no tail
    const lane = [...run.tg.gw.lanes.values()][0]
    await lane.kill('test')
    const disk = Deno.readTextFileSync(lane.logFile).split('\n').filter(Boolean)
    const joined = recs.flatMap((r) => replayLog(r!, run.tg.gw.store))
    assertEquals(disk, joined)
    assertEquals(run.tg.gw.store.tail(r3.response.id), [])
  })
  assert(run.tg.events('verify_ok').length > 0)
})

/** The same conversation, live and disrupted. */
async function conversation(run: Run): Promise<void> {
  const f = run.fake
  f.reply({ blocks: [think('a'), text('T1 reply')] })
  await run.turn('T1 hello')
  f.reply({ blocks: [think('b'), call('toolu_1', 'echo', { text: 'one' }), call('toolu_2', 'read', { name: 'two' })] }, { blocks: [text('T2 reply')] })
  await run.turn('T2 use tools')
  await run.disrupt('idle')
  f.reply({ blocks: [text('T3 reply')] })
  await run.turn('T3 after an idle eviction')
  await run.disrupt('restart')
  f.reply({ blocks: [call('toolu_3', 'echo', { text: 'three' })] }, { blocks: [think('c'), text('T4 reply')] })
  await run.turn('T4 after a gateway restart', ['NOTICE-T4'])
  await run.disrupt('restart-lost-store')
  f.reply({ blocks: [text('T5 reply')] })
  await run.turn('T5 after a restart that lost the store')
  await run.disrupt('idle')
  f.reply({ blocks: [call('toolu_4', 'read', { name: 'four' })] }, { blocks: [text('T6 reply')] })
  await run.turn('T6 last')
}

scenarioTest('kill/resume and gateway restarts: every request is byte-identical to the live process', async () => {
  const control = new Run('bytes-control', true)
  const evicted = new Run('bytes-evicted', false)
  await control.start()
  await evicted.start()
  try {
    await conversation(control)
    await conversation(evicted)
    const a = control.fake.main(), b = evicted.fake.main()
    assertSameRequests(a, b, control.normalize, evicted.normalize)
    // one metadata.user_id for the whole conversation, through every rebuild (the lost store restarted on a fresh state dir)
    assertOneUserId(a)
    assertOneUserId(b)
    // and each post-disruption request repeats the one before it, up to the new tail
    for (const d of evicted.disruptions) assertPrefix(b[d.beforeRequest - 1], b[d.beforeRequest])
    assertEquals(evicted.disruptions.map((d) => d.kind), ['idle', 'restart', 'restart-lost-store', 'idle'])
    // the rebuild paths taken
    const paths = evicted.gateways.flatMap((g) => g.events('request').map((e) => e.data.path))
    assert(paths.includes('store') && paths.includes('history'), paths.join(','))
    const hist = evicted.drv.results.find((r) => r.response.x_gateway?.path === 'history')!
    assertEquals(hist.response.x_gateway.synthesized_groups, 0)
    assertEquals(hist.response.x_gateway.records, 6)
  } finally {
    await control.close()
    await evicted.close()
  }
})

scenarioTest('idle timeout kills the process and the next request rebuilds it', async () => {
  const run = new Run('idle-timer', false, { idleTimeoutMs: 300 })
  await run.run(async () => {
    run.fake.reply({ blocks: [text('first')] })
    await run.turn('one')
    const killed = await run.tg.waitEvent('kill', (d) => d.reason === 'idle_timeout', 5000)
    assertExists(killed)
    assertEquals(run.tg.gw.lanes.size, 0)
    run.fake.reply({ blocks: [text('second')] })
    const r = await run.turn('two')
    assertEquals(r.response.x_gateway.path, 'store')
    const [x, y] = run.fake.main()
    assertPrefix(x, y)
    assertStringIncludes(JSON.stringify(y.body.messages.at(-1)), 'two')
  })
})

scenarioTest("chains running in parallel share one Claude config folder without corrupting it or each other's logs", async () => {
  const { Driver } = await import('./harness.ts')
  const { INSTRUCTIONS, MODEL, TOOLS, toolsImpl } = await import('./scenario.ts')
  const run = new Run('shared-config', false)
  await run.run(async () => {
    // replies follow each request, whatever order the chains' requests come in
    run.fake.fallback = (ex) => {
      const last = JSON.stringify(ex.body.messages.at(-1))
      return last.includes('tool_result')
        ? { blocks: [text(`done ${ex.n}`)], gapMs: 50 }
        : { blocks: [call(`toolu_p${ex.n}`, 'echo', { text: `x${ex.n}` })], gapMs: 50 }
    }
    const chains = Array.from({ length: 5 }, () => new Driver(run.tg.client, { instructions: INSTRUCTIONS, tools: TOOLS, model: MODEL, mode: 'previous' }))
    for (let round = 0; round < 3; round++) {
      await Promise.all(chains.map((d, i) => d.turn(`chain ${i} round ${round}`, toolsImpl)))
    }
    const lanes = [...run.tg.gw.lanes.values()]
    assertEquals(lanes.length, 5)
    const config = run.tg.gw.config.stateDir + '/claude/config'
    for (const lane of lanes) {
      assertEquals(lane.configDir, config)
      assert(lane.logFile.startsWith(`${config}/projects/`))
    }
    await Promise.all(lanes.map((l) => l.kill('test')))
    // every log is exactly its chain's records, and the shared state file is intact
    for (const [i, d] of chains.entries()) {
      const lane = lanes.find((l) => l.head?.responseId === d.prevId)!
      const recs = run.tg.gw.store.chain(d.prevId!)!
      const disk = Deno.readTextFileSync(lane.logFile).split('\n').filter(Boolean)
      assertEquals(disk, [...recs.flatMap((r) => replayLog(r, run.tg.gw.store)), ...run.tg.gw.store.tail(d.prevId!)], `chain ${i}`)
    }
    JSON.parse(Deno.readTextFileSync(`${config}/.claude.json`))
    assertEquals(run.tg.events('verify_error').length, 0)
    assertEquals(run.tg.events('verify_ok').length, 5)
  })
})

scenarioTest("the gateway's device id is seeded into the shared config folder, sent as metadata.user_id's device_id and noted in records", async () => {
  const run = new Run('device-id', false)
  await run.run(async () => {
    run.fake.reply({ blocks: [text('one')] })
    const r = await run.turn('one')
    const rec = (await recordOf(r))!
    assertEquals(rec.device, run.deviceId)
    const meta = JSON.parse(run.fake.main()[0].body.metadata.user_id)
    assertEquals([meta.device_id, meta.session_id], [rec.device, rec.session])
    const lane = [...run.tg.gw.lanes.values()][0]
    assertEquals(JSON.parse(Deno.readTextFileSync(`${lane.configDir}/.claude.json`)).userID, rec.device)
  })
})

scenarioTest('a rebuild on a completely fresh state dir configured with the same device id sends the same metadata.user_id', async () => {
  const run = new Run('fresh-state-metadata', false)
  await run.run(async () => {
    run.fake.reply({ blocks: [text('one')] })
    await run.turn('one')
    const before = Deno.realPathSync(run.d.stateDir)
    await run.disrupt('restart-lost-store')
    assert(Deno.realPathSync(run.d.stateDir) !== before)
    run.fake.reply({ blocks: [text('two')] })
    const r = await run.turn('two')
    assertEquals([r.response.x_gateway.path, r.response.x_gateway.records], ['history', 1])
    const [x, y] = run.fake.main()
    assertEquals(y.body.metadata, x.body.metadata)
    assertPrefix(x, y)
  })
})

scenarioTest('every session runs in the one working folder, whatever the conversation', async () => {
  const run = new Run('one-work-dir', false)
  await run.run(async () => {
    run.fake.reply({ blocks: [text('a')] }, { blocks: [text('b')] })
    await run.turn('chain one')
    const { send } = await import('./harness.ts')
    const { INSTRUCTIONS, MODEL, TOOLS } = await import('./scenario.ts')
    await send(run.tg.client, { model: MODEL, instructions: INSTRUCTIONS, tools: TOOLS, input: 'chain two' })
    const [x, y] = run.fake.main()
    // two conversations, one environment block
    assertEquals(JSON.stringify(x.body.messages[1]), JSON.stringify(y.body.messages[1]))
    assertStringIncludes(JSON.stringify(x.body.messages[1]), `Primary working directory: ${run.tg.gw.config.workDir}\\n`)
    assertEquals([...Deno.readDirSync(run.tg.gw.config.workDir)].length, 0, 'nothing is created in it')
  })
})

scenarioTest('a fresh state dir with another device id rebuilds the same model bytes; only metadata.user_id differs, and the mismatch is noted', async () => {
  const run = new Run('other-device', false)
  await run.run(async () => {
    run.fake.reply({ blocks: [text('one')] })
    await run.turn('one')
    const first = run.deviceId
    run.deviceId = 'f'.repeat(64)
    await run.disrupt('restart-lost-store')
    run.fake.reply({ blocks: [text('two')] })
    const r = await run.turn('two')
    assertEquals([r.response.x_gateway.path, r.response.x_gateway.records, r.response.x_gateway.synthesized_groups], ['history', 1, 0])
    const [x, y] = run.fake.main()
    const mx = JSON.parse(x.body.metadata.user_id), my = JSON.parse(y.body.metadata.user_id)
    assertEquals([mx.device_id, my.device_id], [first, 'f'.repeat(64)])
    assertEquals(my.session_id, mx.session_id)
    // everything the model sees repeats what it saw before
    assertPrefix({ ...x, body: { ...x.body, metadata: null } }, { ...y, body: { ...y.body, metadata: null } })
    assertEquals(run.tg.events('device_mismatch').map((e) => e.data.records), [[first]])
    // and the gateway keeps its own id: the shared folder is not re-seeded with the records' one
    assertEquals(JSON.parse(Deno.readTextFileSync(`${run.tg.gw.config.stateDir}/claude/config/.claude.json`)).userID, 'f'.repeat(64))
  })
})

import { scenarioTest } from './scenario.ts'
// The fake-endpoint matrix: midnight, moved folder, records-less history, turn-start notices, the queued-notice native continuation,
// cancellation and interrupts, stale-call fencing, typed errors.
import { assert, assertEquals, assertNotEquals, assertRejects, assertStringIncludes, assertThrows } from '@std/assert'
import { call, type Json, text, think } from './fake.ts'
import { assertPrefix, sameRequest, send, TestGateway, user } from './harness.ts'
import { INSTRUCTIONS, MODEL, Run, TOOLS } from './scenario.ts'

const dateIn = (tz: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
const lastText = (body: Json): string => JSON.stringify(body.messages.at(-1))

scenarioTest('midnight via the TZ trick: the date change is appended at the tail, the old date stays', async () => {
  const [tzA, tzB] = ['Etc/GMT+12', 'Etc/GMT-14']
  assertNotEquals(dateIn(tzA), dateIn(tzB))
  const run = new Run('midnight', false, { tz: tzA })
  await run.run(async () => {
    run.fake.reply({ blocks: [text('day one')] })
    await run.turn('M1 before midnight')
    await run.disrupt('restart', { tz: tzB })
    run.fake.reply({ blocks: [text('day two')] })
    await run.turn('M2 after midnight')
    await run.disrupt('idle')
    run.fake.reply({ blocks: [call('toolu_m', 'echo', { text: 'x' })] })
    const r = await run.send([user('M3 a tool, evicted during the hold')])
    await run.disrupt('restart-lost-store', { tz: tzB })
    run.fake.reply({ blocks: [text('M3 reply')] })
    await run.send([{ type: 'function_call_output', call_id: run.drv.calls(r)[0].call_id, output: 'X' }])
    const [m1, m2, m3, m3b] = run.fake.main()
    assertStringIncludes(JSON.stringify(m1.body.messages[1]), `Today's date is ${dateIn(tzA)}.`)
    assertPrefix(m1, m2)
    const changed = `The date has changed. Today's date is now ${dateIn(tzB)}. No need to announce the new date — the user's own clock shows it.`
    assertStringIncludes(lastText(m2.body), changed)
    assertStringIncludes(JSON.stringify(m2.body.messages[1]), `Today's date is ${dateIn(tzA)}.`)
    // recorded once, never announced again
    assertPrefix(m2, m3)
    assertPrefix(m3, { ...m3b, body: { ...m3b.body, messages: m3b.body.messages.slice(0, m3.body.messages.length) } })
    for (const ex of [m3, m3b]) assertEquals(JSON.stringify(ex.body).split('The date has changed').length - 1, 1)
  })
})

scenarioTest('negative control: a moved working folder appends an environment update at the tail', async () => {
  const run = new Run('moved', false)
  const old = run.d.workDir
  await run.run(async () => {
    run.fake.reply({ blocks: [text('here')] })
    await run.turn('F1')
    await run.disrupt('restart', { workDir: `${old}-moved` })
    run.fake.reply({ blocks: [text('there')] })
    await run.turn('F2 from a moved folder')
    await run.disrupt('idle')
    run.fake.reply({ blocks: [text('still there')] })
    await run.turn('F3')
    const [f1, f2, f3] = run.fake.main()
    assertPrefix(f1, f2)
    const previousDir = Deno.realPathSync(old), movedDir = Deno.realPathSync(`${old}-moved`)
    assertStringIncludes(lastText(f2.body), `# Environment update\\n - Primary working directory: ${movedDir} (was ${previousDir})`)
    assertPrefix(f2, f3)
    assert(!lastText(f3.body).includes('Environment update'))
  })
  try {
    Deno.removeSync(`${old}-moved`, { recursive: true })
  } catch { /* gone */ }
})

scenarioTest('negative control: a history without provider records is synthesized (cold), and its next record makes it warm again', async () => {
  const run = new Run('recordless', false)
  await run.run(async () => {
    run.fake.reply({ blocks: [think('p'), text('R1')] })
    await run.turn('R1 hello')
    run.fake.reply({ blocks: [call('toolu_n', 'read', { name: 'n' })] }, { blocks: [text('R2')] })
    await run.turn('R2 tool', ['NOTICE-R2'])
    // the client kept everything but the provider records
    run.drv.history = run.drv.history.filter((i: Json) => !(i.type === 'reasoning' && i.encrypted_content?.startsWith('cc2r.record.')))
    await run.disrupt('restart-lost-store')
    run.fake.reply({ blocks: [text('R3')] })
    const r3 = await run.turn('R3 after losing everything')
    assertEquals(r3.response.x_gateway.path, 'history')
    assertEquals(r3.response.x_gateway.records, 0)
    assertEquals(r3.response.x_gateway.synthesized_groups, 3)
    const reqs = run.fake.main()
    const before = reqs[2], after = reqs[3]
    // the model still sees the whole conversation...
    for (const s of ['R1 hello', 'R2 tool', 'CONTENT OF n', 'NOTICE-R2', 'R3 after losing everything']) {
      assertStringIncludes(JSON.stringify(after.body.messages), s)
    }
    // ...but not the prefix it saw before: a cache miss
    assertThrows(() => assertPrefix(before, after))
    // from here on the records cover the synthesized history too
    run.fake.reply({ blocks: [text('R4')] })
    await run.turn('R4 live')
    await run.disrupt('restart-lost-store')
    run.fake.reply({ blocks: [text('R5')] })
    const r5 = await run.turn('R5 after losing the store again')
    assertEquals(r5.response.x_gateway.records, 2)
    assertEquals(r5.response.x_gateway.synthesized_groups, 0)
    const all = run.fake.main()
    assertPrefix(all[4], all[5])
  })
})

scenarioTest('notices at a turn start go in through stdin as one user turn', async () => {
  const run = new Run('turnstart', false)
  await run.run(async () => {
    run.fake.reply({ blocks: [text('one')] }, { blocks: [text('two')] })
    await run.turn('S1')
    const r = await run.send([user('NOTICE-1: something happened'), user('S2 and my question')])
    assertEquals(r.status, 'completed')
    const last = run.fake.main().at(-1)!.body.messages.at(-1)
    assertEquals(last.role, 'user')
    assertEquals(last.content.map((b: Json) => b.text), ['NOTICE-1: something happened', 'S2 and my question'])
  })
})

scenarioTest('a notice delivered at the queued-notice native continuation continues inference within the same response', async () => {
  const run = new Run('stophook', false)
  await run.run(async () => {
    // Hidden native calls can continue inference after the queued notice has reached the model.
    run.fake.reply({ blocks: [call('toolu_k', 'echo', { text: 'k' }), call('toolu_u', 'nonexistent', {})] }, {
      blocks: [text('first part'), call('toolu_continue', 'nonexistent', {})],
    }, {
      blocks: [text('second part')],
    })
    await run.send([user('T1')])
    const r = await run.send([{ type: 'function_call_output', call_id: 'toolu_k', output: 'K' }, user('NOTICE-STOP')])
    assertEquals(r.status, 'completed')
    assertEquals(run.drv.text(r), 'first partsecond part')
    assertEquals(run.tg.events('notice').map((n) => n.data.via), ['queue'])
    assertEquals(run.tg.events('completed').length, 2)
    const reqs = run.fake.main()
    assertEquals(reqs.length, 3)
    assertStringIncludes(JSON.stringify(reqs[1].body.messages), 'NOTICE-STOP')
    // and the record of that response replays both messages after an eviction
    await run.disrupt('idle')
    run.fake.reply({ blocks: [text('later')] })
    await run.turn('T2')
    assertPrefix(reqs[2], run.fake.main()[3])
  })
})

async function streamUntil(tg: TestGateway, body: Json, pred: (ev: Json) => boolean, onHit: (ev: Json) => Promise<void>): Promise<Json> {
  const stream = await tg.client.responses.create({ ...body, stream: true })
  let final: Json = null
  let hit = false
  for await (const ev of stream as unknown as AsyncIterable<Json>) {
    if (!hit && pred(ev)) {
      hit = true
      await onHit(ev)
    }
    if (ev.type === 'response.completed' || ev.type === 'response.failed') final = ev.response
  }
  return final
}

scenarioTest('cancel mid-stream: the response fails as cancelled, the process goes, the next request rebuilds the same prefix', async () => {
  const run = new Run('cancel', false)
  await run.run(async () => {
    run.fake.reply({ blocks: [text('C1')] })
    await run.turn('C1')
    run.fake.reply({ blocks: [text('partial'), text('never sent')], gapMs: 1500 })
    let id = ''
    const body = { model: MODEL, instructions: INSTRUCTIONS, tools: TOOLS, previous_response_id: run.drv.prevId, input: [user('C2 slow')] }
    const final = await streamUntil(run.tg, run.shape(body), (ev) => ev.type === 'response.output_text.delta', async (ev) => {
      id = ev.item_id && (run.tg.gw.lanes.values().next().value!.active!.state.id)
      const res = await fetch(`${run.tg.url}/v1/responses/${id}/cancel`, { method: 'POST' })
      assertEquals(res.status, 200)
      assertEquals((await res.json()).status, 'cancelled')
    })
    assertEquals(final.status, 'cancelled')
    assertEquals(final.error.code, 'cancelled')
    assertEquals(run.tg.gw.lanes.size, 0)
    assertEquals((await run.tg.waitEvent('kill')).reason, 'cancel_request')
    // a cancelled response is not a continuation point; the client goes on from the last completed one
    const again = await fetch(`${run.tg.url}/v1/responses/${id}/cancel`, { method: 'POST' })
    assertEquals(again.status, 404)
    await again.body?.cancel()
    run.fake.reply({ blocks: [text('C2 done')] })
    const r = await run.send([user('C2 slow')])
    assertEquals(r.response.x_gateway.path, 'store')
    const reqs = run.fake.main()
    // the retried request is exactly the cancelled one
    assert(sameRequest(reqs[1], reqs[2]))
    const done = await fetch(`${run.tg.url}/v1/responses/${r.response.id}/cancel`, { method: 'POST' })
    assertEquals(done.status, 409)
    await done.body?.cancel()
  })
})

scenarioTest('interrupt while the released calls continue: the outputs come again and resume the interrupted turn', async () => {
  const run = new Run('interrupt', false)
  await run.run(async () => {
    run.fake.reply({ blocks: [call('toolu_i', 'echo', { text: 'i' })] })
    const r1 = await run.send([user('I1')])
    run.fake.reply({ blocks: [text('slow'), text('answer')], gapMs: 1500 })
    const body = {
      model: MODEL,
      instructions: INSTRUCTIONS,
      tools: TOOLS,
      previous_response_id: r1.response.id,
      input: [{ type: 'function_call_output', call_id: 'toolu_i', output: 'I-OUT' }],
    }
    const final = await streamUntil(run.tg, run.shape(body), (ev) => ev.type === 'response.output_text.delta', async () => {
      const id = run.tg.gw.lanes.values().next().value!.active!.state.id
      await (await fetch(`${run.tg.url}/v1/responses/${id}/cancel`, { method: 'POST' })).body?.cancel()
    })
    assertEquals(final.status, 'cancelled')
    run.fake.reply({ blocks: [text('I done')] })
    const r2 = await run.send([{ type: 'function_call_output', call_id: 'toolu_i', output: 'I-OUT' }])
    assertEquals(r2.status, 'completed')
    assertEquals(r2.response.x_gateway.resume, 'interrupted_turn')
  })
})

scenarioTest('a client that goes away mid-stream cancels the response', async () => {
  const run = new Run('disconnect', false)
  await run.run(async () => {
    run.fake.reply({ blocks: [text('a'), text('b')], gapMs: 1500 })
    const ctl = new AbortController()
    const res = await fetch(`${run.tg.url}/v1/responses`, {
      method: 'POST',
      signal: ctl.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, instructions: INSTRUCTIONS, tools: TOOLS, input: 'D1', stream: true }),
    })
    const reader = res.body!.getReader()
    let seen = ''
    while (!seen.includes('output_text.delta')) seen += new TextDecoder().decode((await reader.read()).value)
    ctl.abort()
    await run.tg.waitEvent('client_disconnect')
    await run.tg.waitEvent('kill', (d) => d.reason === 'client_disconnected')
    assertEquals(run.tg.gw.lanes.size, 0)
  })
})

scenarioTest('stale calls from a killed process are fenced by its epoch', async () => {
  const run = new Run('fence', false)
  await run.run(async () => {
    run.fake.reply({ blocks: [call('toolu_f', 'echo', { text: 'f' })] })
    const r = await run.send([user('F1')])
    await run.tg.waitEvent('hold')
    const epoch = run.tg.events('spawn')[0].data.epoch
    await run.disrupt('hold')
    const bridge = run.tg.gw.bridge
    const post = (path: string, body: Json) =>
      fetch(`${bridge.url}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${bridge.bearer}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    const late = await post(`/mcp/${epoch}`, {
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: { name: 'echo', arguments: {}, _meta: { 'claudecode/toolUseId': 'toolu_f' } },
    })
    assertEquals(late.status, 410)
    assertEquals((await late.json()).error.code, -32001)
    assertEquals(bridge.fenced.filter((f) => f.epoch === epoch).length, 1)
    // the new process gets its own epoch and the output reaches it
    run.fake.reply({ blocks: [text('F done')] })
    const r2 = await run.send([{ type: 'function_call_output', call_id: run.drv.calls(r)[0].call_id, output: 'F' }])
    assertEquals(r2.status, 'completed')
    assertNotEquals(run.tg.events('spawn')[1].data.epoch, epoch)
    const noAuth = await fetch(`${bridge.url}/mcp/${run.tg.events('spawn')[1].data.epoch}`, { method: 'POST', body: '{}' })
    assertEquals(noAuth.status, 401)
    await noAuth.body?.cancel()
  })
})

scenarioTest('typed errors: the subset, unknown ids, wrong outputs, a busy chain, the context limit, oversized outputs', async () => {
  const run = new Run('errors', false)
  const base = { model: MODEL, instructions: INSTRUCTIONS, tools: TOOLS }
  const expect = async (body: Json, status: number, code: string) => {
    const res = await fetch(`${run.tg.url}/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const j = await res.json()
    assertEquals([res.status, j.error?.code], [status, code], JSON.stringify(j))
    assert(typeof j.error.message === 'string' && 'type' in j.error && 'param' in j.error)
  }
  await run.run(async () => {
    await expect({ ...base, input: 'x' }, 400, 'unsupported') // stream missing
    await expect({ ...base, input: 'x', stream: true, store: 'false' }, 400, 'invalid_request')
    await expect({ ...base, input: 'x', stream: true, background: true }, 400, 'unsupported')
    await expect({ ...base, input: 'x', stream: true, tools: [{ type: 'web_search' }] }, 400, 'unsupported')
    await expect({ ...base, input: 'x', stream: true, tool_choice: 'required' }, 400, 'unsupported')
    await expect({ ...base, input: [{ role: 'system', content: 'x' }], stream: true }, 400, 'invalid_request')
    await expect({ ...base, input: [{ type: 'item_reference', id: 'x' }], stream: true }, 400, 'unsupported')
    await expect({ ...base, input: 'x', stream: true, max_output_tokens: 0 }, 400, 'invalid_request')
    await expect({ ...base, input: 'x', stream: true, frequency_penalty: 1 }, 400, 'unsupported')
    await expect({ ...base, input: 'x', stream: true, previous_response_id: 'resp_nope' }, 400, 'previous_response_not_found')
    await expect({ ...base, instructions: undefined, input: 'x', stream: true }, 400, 'invalid_request')

    run.fake.reply({ blocks: [call('toolu_e', 'echo', { text: 'e' })] })
    const r1 = await run.send([user('E1')])
    const prev = { ...run.shape({ ...base, previous_response_id: r1.response.id, input: [] }), stream: true }
    await expect({ ...prev, input: [user('no outputs')] }, 400, 'missing_tool_output')
    await expect({ ...prev, input: [{ type: 'function_call_output', call_id: 'toolu_zz', output: 'x' }] }, 400, 'unexpected_tool_output')
    await expect({ ...prev, input: [{ type: 'function_call_output', call_id: 'toolu_e', output: 'x'.repeat(500_001) }] }, 400, 'tool_output_too_large')
    await expect(
      { ...prev, instructions: 'Different instructions.', input: [{ type: 'function_call_output', call_id: 'toolu_e', output: 'x' }] },
      400,
      'previous_response_not_found',
    )

    // a second request on a chain whose response is still streaming
    run.fake.reply({ blocks: [text('slow'), text('reply')], gapMs: 1200 })
    const slow = send(run.tg.client, { ...prev, input: [{ type: 'function_call_output', call_id: 'toolu_e', output: 'E' }] })
    await run.fake.waitMain(2)
    await expect({ ...prev, input: [{ type: 'function_call_output', call_id: 'toolu_e', output: 'E' }] }, 409, 'conversation_busy')
    const done = await slow
    assertEquals(done.status, 'completed')

    // the blocking context limit: auto-compaction is off, so Claude Code refuses and the gateway says so
    run.fake.reply({ blocks: [text('huge')], usage: { input_tokens: 960_000 } })
    const big = await send(run.tg.client, { ...base, input: 'L1' })
    assertEquals(big.status, 'completed')
    const over = await send(run.tg.client, { ...base, previous_response_id: big.response.id, input: 'L2' })
    assertEquals(over.status, 'failed')
    assertEquals(over.response.error.code, 'context_length_exceeded')
    assert(!run.fake.exchanges.some((e) => e.kind === 'side' && JSON.stringify(e.body).includes('summar')), 'no compaction request')
    await assertRejects(() => run.tg.client.responses.create({ ...base, input: 'x', stream: true, previous_response_id: 'resp_unknown' } as Json))
  })
})

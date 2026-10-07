// Regression tests for the M1 review findings.
import { assert, assertEquals, assertRejects, assertStringIncludes, assertThrows } from '@std/assert'
import { decodeRecord, encodeRecord } from '../src/records.ts'
import { parseRequest } from '../src/api/request.ts'
import { RESUME_LINE } from '../src/claude/pins.ts'
import { call, type Json, text, think } from './fake.ts'
import { assertPrefix, freePort, output, user } from './harness.ts'
import { INSTRUCTIONS, MODEL, Run, TOOLS } from './scenario.ts'

/** Posts a request; an event stream is read to its end (dropping it would cancel the response). */
async function post(url: string, body: Json): Promise<{ status: number; body: Json; events?: string }> {
  const res = await fetch(`${url}/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  if (res.headers.get('content-type')?.includes('event-stream')) return { status: res.status, body: null, events: await res.text() }
  return { status: res.status, body: await res.json() }
}

Deno.test('a client record whose session is a path is refused before any file is touched', async () => {
  const victim = `/tmp/cc2r-victim-${Date.now()}`
  Deno.mkdirSync(victim, { recursive: true })
  Deno.writeTextFileSync(`${victim}/canary`, 'alive')
  const run = new Run('forged-session', false)
  await run.run(async () => {
    run.fake.reply({ blocks: [text('one')] })
    await run.turn('one')
    const history = structuredClone(run.drv.history)
    const item = history.find((i: Json) => i.type === 'reasoning' && i.encrypted_content?.startsWith('cc2r.record.'))
    const rec = (await decodeRecord(item.encrypted_content))!
    for (const session of [`${'../'.repeat(24)}${victim.slice(1)}`, 'not-a-uuid']) {
      item.encrypted_content = await encodeRecord({ ...rec, session })
      const r = await post(run.tg.url, { model: MODEL, instructions: INSTRUCTIONS, tools: TOOLS, stream: true, input: [...history, user('two')] })
      assertEquals([r.status, r.body?.error?.code], [400, 'invalid_provider_record'])
    }
    // other fields that reach paths or the log are checked too
    for (const bad of [{ id: '../x' }, { prev: 'resp_../x' }, { entries: ['{"a":1}\n{"b":2}'] }, { entries: ['not json'] }, { end: 'calls', calls: [] }]) {
      item.encrypted_content = await encodeRecord({ ...rec, ...bad } as Json)
      const r = await post(run.tg.url, { model: MODEL, instructions: INSTRUCTIONS, tools: TOOLS, stream: true, input: [...history, user('two')] })
      assertEquals([r.status, r.body?.error?.code], [400, 'invalid_provider_record'], JSON.stringify(bad))
    }
    assertEquals(Deno.readTextFileSync(`${victim}/canary`), 'alive')
  })
  Deno.removeSync(victim, { recursive: true })
})

Deno.test('an MCP call whose body finishes after its process was killed is fenced, never dispatched', async () => {
  const { Bridge } = await import('../src/bridge.ts')
  const bridge = new Bridge(freePort())
  let dispatched = 0
  bridge.register('ep_race', {
    mcpTools: () => [],
    toolCall: () => {
      dispatched++
      return Promise.resolve({ content: [] })
    },
    hook: () => {
      dispatched++
      return {}
    },
  })
  const enc = new TextEncoder()
  for (const kind of ['mcp', 'hook']) {
    let push!: (s: string | null) => void
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        push = (s) => (s === null ? c.close() : c.enqueue(enc.encode(s)))
      },
    })
    const res = fetch(
      `${bridge.url}/${kind}/ep_race`,
      { method: 'POST', headers: { authorization: `Bearer ${bridge.bearer}` }, body, duplex: 'half' } as RequestInit,
    )
    push('{"jsonrpc":"2.0","id":1,')
    await new Promise((r) => setTimeout(r, 200))
    if (kind === 'hook') bridge.unregister('ep_race')
    else bridge.unregister('ep_race')
    push('"method":"tools/call","params":{"name":"echo","_meta":{"claudecode/toolUseId":"toolu_x"}},"hook_event_name":"Stop"}')
    push(null)
    const r = await res
    assertEquals(r.status, 410)
    await r.body?.cancel()
    bridge.register('ep_race', { mcpTools: () => [], toolCall: () => Promise.resolve({}), hook: () => ({}) })
    bridge.unregister('ep_race')
  }
  assertEquals(dispatched, 0)
  await bridge.close()
})

Deno.test('a killed lane answers late MCP calls and hooks as stale, without touching its results', async () => {
  const run = new Run('dead-lane', false)
  await run.run(async () => {
    run.fake.reply({ blocks: [call('toolu_d1', 'echo', { text: 'a' }), call('toolu_d2', 'echo', { text: 'b' })] })
    await run.send([user('two calls')])
    await run.tg.waitEvent('hold')
    const lane = [...run.tg.gw.lanes.values()][0]
    await lane.kill('test')
    const { StaleEpoch } = await import('../src/bridge.ts')
    const late = lane.toolCall('toolu_d2', 'echo', {}, new AbortController().signal)
    const timeout = new Promise((_, no) => setTimeout(() => no(new Error('a late call was held by a dead lane')), 1000))
    await assertRejects(() => Promise.race([late, timeout]), StaleEpoch)
    assertThrows(() => lane.hook({ hook_event_name: 'PostToolUse', tool_use_id: 'toolu_d1' }), StaleEpoch)
  })
})

Deno.test('two simultaneous continuations of one chain: one runs, the other is conversation_busy, no process is lost', async () => {
  const { GatewayError } = await import('../src/errors.ts')
  const run = new Run('concurrent', false)
  await run.run(async () => {
    run.fake.reply({ blocks: [text('one')] })
    await run.turn('one')
    for (const evict of [true, false]) {
      if (evict) await run.disrupt('idle')
      run.fake.reply({ blocks: [text('slow')], gapMs: 300 })
      const body = {
        model: MODEL,
        instructions: INSTRUCTIONS,
        tools: TOOLS,
        stream: true,
        previous_response_id: run.drv.prevId,
        input: [user(evict ? 'two' : 'three')],
      }
      // both enter the gateway in the same tick
      const outcomes = await Promise.allSettled([run.tg.gw.create(parseRequest(body)), run.tg.gw.create(parseRequest(body))])
      const won = outcomes.filter((o) => o.status === 'fulfilled') as PromiseFulfilledResult<ReadableStream<Uint8Array>>[]
      const lost = outcomes.filter((o) => o.status === 'rejected') as PromiseRejectedResult[]
      assertEquals([won.length, lost.length], [1, 1])
      assert(lost[0].reason instanceof GatewayError && lost[0].reason.code === 'conversation_busy', String(lost[0].reason))
      const events = await new Response(won[0].value).text()
      assert(events.includes('response.completed'), JSON.stringify(/"error":(\{[^}]*\})/.exec(events)?.[1]) + ' evict=' + evict)
      assertEquals(run.tg.events('spawn').length, 2)
      run.drv.prevId = run.tg.events('completed').at(-1)!.data.response
    }
  })
})

Deno.test('what Claude Code writes after a response is kept as its tail and carried into the next record', async () => {
  const run = new Run('tail', false)
  await run.run(async () => {
    run.fake.reply({ blocks: [text('one')] })
    const r1 = await run.turn('one')
    const lane = [...run.tg.gw.lanes.values()][0]
    // an entry logged after the response completed (Claude Code's session metadata does this)
    const extra = JSON.stringify({ type: 'custom-title', customTitle: 'tail test', sessionId: lane.sessionId })
    Deno.writeTextFileSync(lane.logFile, extra + '\n', { append: true })
    await run.disrupt('idle')
    assertEquals(run.tg.gw.store.tail(r1.response.id), [extra])
    run.fake.reply({ blocks: [text('two')] })
    const r2 = await run.turn('two')
    assertEquals(r2.response.x_gateway.path, 'store')
    const rec2 = (await decodeRecord(r2.response.output.at(-1).encrypted_content))!
    assertEquals(rec2.entries[0], extra)
    const [q1, q2] = run.fake.main()
    assertPrefix(q1, q2)
    // the full log is the records, the tail included
    const lane2 = [...run.tg.gw.lanes.values()][0]
    await lane2.kill('test')
    const rec1 = (await decodeRecord(r1.response.output.at(-1).encrypted_content))!
    assertEquals(Deno.readTextFileSync(lane2.logFile).split('\n').filter(Boolean), [...rec1.entries, ...rec2.entries])
  })
})

Deno.test('a cancelled attempt never becomes a tail', async () => {
  const run = new Run('tail-cancel', false)
  await run.run(async () => {
    run.fake.reply({ blocks: [text('one')] })
    const r1 = await run.turn('one')
    run.fake.reply({ blocks: [text('partial'), text('rest')], gapMs: 1000 })
    const stream = await run.tg.gw.create(
      parseRequest({ model: MODEL, instructions: INSTRUCTIONS, tools: TOOLS, stream: true, previous_response_id: r1.response.id, input: [user('two')] }),
    )
    const reader = stream.getReader()
    let seen = ''
    while (!seen.includes('output_text.delta')) seen += new TextDecoder().decode((await reader.read()).value)
    const lane = [...run.tg.gw.lanes.values()][0]
    lane.cancel(lane.active!.state.id, 'test')
    await lane.gone
    assertEquals(run.tg.gw.store.tail(r1.response.id), [])
  })
})

Deno.test('history with tool arguments that are not a JSON object is refused, never rewritten', async () => {
  const run = new Run('bad-args', false)
  await run.run(async () => {
    for (const args of ['not json', '', '[1,2]', '"text"']) {
      const input = [user('q'), { type: 'function_call', call_id: 'call_1', name: 'echo', arguments: args }, {
        type: 'function_call_output',
        call_id: 'call_1',
        output: 'x',
      }]
      const r = await post(run.tg.url, { model: MODEL, instructions: INSTRUCTIONS, tools: TOOLS, stream: true, input })
      assertEquals([r.status, r.body?.error?.code, r.body?.error?.param], [400, 'invalid_function_arguments', 'input[1].arguments'], args)
    }
    assertEquals(run.fake.main().length, 0)
  })
})

Deno.test('state, records and logs are owner-only under umask 022', async () => {
  const old = Deno.umask(0o022)
  const run = new Run('perms', false)
  try {
    await run.run(async () => {
      run.fake.reply({ blocks: [text('one')] })
      const r = await run.turn('one')
      const lane = [...run.tg.gw.lanes.values()][0]
      await lane.kill('test')
      const mode = (p: string) => Deno.statSync(p).mode! & 0o777
      const state = Deno.realPathSync(run.d.stateDir)
      for (
        const d of [state, `${state}/responses`, `${state}/tails`, `${state}/claude/config`, `${state}/run`, Deno.realPathSync(run.d.workRoot), lane.workDir]
      ) {
        assertEquals(mode(d), 0o700, d)
      }
      assertEquals(mode(`${state}/responses/${r.response.id}.json`), 0o600)
    })
  } finally {
    Deno.umask(old)
  }
})

Deno.test('MCP calls with an unknown tool id are refused; duplicate ids share the one output', async () => {
  const run = new Run('mcp-ids', false)
  await run.run(async () => {
    run.fake.reply({ blocks: [call('toolu_m1', 'echo', { text: 'a' }), call('toolu_m2', 'echo', { text: 'b' })] })
    await run.send([user('two calls')])
    await run.tg.waitEvent('hold', (d) => d.call === 'toolu_m1')
    const epoch = run.tg.events('spawn')[0].data.epoch
    const bridge = run.tg.gw.bridge
    const mcp = (id: string) =>
      fetch(`${bridge.url}/mcp/${epoch}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${bridge.bearer}`, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'echo', arguments: {}, _meta: { 'claudecode/toolUseId': id } } }),
      }).then((r) => r.json())
    // an id the model never produced
    const unknown = await Promise.all(['toolu_bogus', 'toolu_bogus', 'toolu_bogus2'].map(mcp))
    for (const u of unknown) assertEquals(u.error.code, -32602)
    assertEquals(run.tg.events('unknown_call').length, 3)
    // their waits are gone once they time out
    assertEquals([...run.tg.gw.lanes.values()][0].unknownCallWaiters, 0)
    // a duplicate of the held call waits beside it and gets the same output
    const dup = mcp('toolu_m1')
    await run.tg.waitEvent('duplicate_call', (d) => d.call === 'toolu_m1')
    run.fake.reply({ blocks: [text('done')] })
    const r = await run.send([{ type: 'function_call_output', call_id: 'toolu_m1', output: 'OUT-1' }, {
      type: 'function_call_output',
      call_id: 'toolu_m2',
      output: 'OUT-2',
    }])
    assertEquals(r.status, 'completed')
    assertEquals((await dup).result.content[0].text, 'OUT-1')
    // after the release a duplicate is answered at once, with the same output
    assertEquals((await mcp('toolu_m2')).result.content[0].text, 'OUT-2')
    // the model saw each output once
    const results = run.fake.main()[1].body.messages.at(-1).content.filter((b: Json) => b.type === 'tool_result')
    assertEquals(results.map((b: Json) => b.tool_use_id), ['toolu_m1', 'toolu_m2'])
  })
})

Deno.test('a work root inside git is refused before anything is created or changed', async () => {
  const { prepare, ConfigError } = await import('../src/config.ts')
  const { CLAUDE, REPO } = await import('./harness.ts')
  const tag = Date.now().toString(36)
  const inGit = `${REPO}/.state/test/in-git-${tag}`
  Deno.mkdirSync(inGit, { recursive: true })
  Deno.chmodSync(inGit, 0o755)
  const stateDir = `/tmp/cc2r-test/refused-state-${tag}`
  for (const workRoot of [inGit, `${inGit}/not/yet/there`]) {
    assertThrows(
      () =>
        prepare({
          hostname: '127.0.0.1',
          port: 1,
          bridgePort: 0,
          stateDir,
          workRoot,
          claudeBinary: CLAUDE,
          tz: 'UTC',
          idleTimeoutMs: 1,
          holdTimeoutMs: 1,
          backendEnv: {},
          verifyLogs: false,
        }),
      ConfigError,
      'inside the git repository',
    )
  }
  assertEquals(Deno.statSync(inGit).mode! & 0o777, 0o755)
  assertThrows(() => Deno.statSync(stateDir))
  assertThrows(() => Deno.statSync(`${inGit}/not`))
  Deno.removeSync(inGit, { recursive: true })
})

Deno.test('an end-of-turn continuation may stream longer than the record timeout', async () => {
  const run = new Run('long-continuation', false, { recordTimeoutMs: 800 })
  await run.run(async () => {
    run.fake.reply(
      { blocks: [call('toolu_k', 'echo', { text: 'k' }), call('toolu_u', 'nonexistent', {})] },
      { blocks: [text('first part')] },
      { blocks: [text('second'), text(' part'), text(' streams slowly')], gapMs: 600 },
    )
    await run.send([user('T1')])
    const r = await run.send([output('toolu_k', 'K'), output('toolu_u', 'unknown tool'), user('NOTICE-STOP')])
    assertEquals(r.status, 'completed', JSON.stringify(r.response.error))
    assertEquals(run.drv.text(r), 'first partsecond part streams slowly')
  })
})

Deno.test('a model message that stops for tool use without calling one fails the response; the chain goes on', async () => {
  const run = new Run('zero-blocks', false, { recordTimeoutMs: 3000 })
  await run.run(async () => {
    run.fake.reply({ blocks: [text('one')] }, { blocks: [], stop: 'tool_use' }, { blocks: [text('fine')] })
    await run.turn('one')
    const r = await run.send([user('two')])
    assertEquals([r.status, r.response.error.code], ['failed', 'malformed_model_message'])
    const r2 = await run.send([user('two again')])
    assertEquals(r2.status, 'completed')
    assertEquals(run.drv.text(r2), 'fine')
  })
})

Deno.test('an exception while handling Claude Code output fails the response visibly, never silently', async () => {
  const run = new Run('frame-error', false)
  await run.run(async () => {
    run.fake.reply({ blocks: [text('one')] }, { blocks: [text('boom')] }, { blocks: [text('fine')] })
    await run.turn('one')
    const lane = [...run.tg.gw.lanes.values()][0] as unknown as { streamEvent: () => void }
    lane.streamEvent = () => {
      throw new Error('injected bug')
    }
    const r = await run.send([user('two')])
    assertEquals([r.status, r.response.error.code], ['failed', 'internal_error'])
    assert(run.tg.events('frame_error').length > 0)
    const r2 = await run.send([user('two again')])
    assertEquals(r2.status, 'completed')
  })
})

Deno.test('an empty model message that ends the turn completes; what Claude Code does next stays in the response', async () => {
  const run = new Run('empty-turn', false, { recordTimeoutMs: 3000 })
  await run.run(async () => {
    run.fake.reply({ blocks: [] }, { blocks: [text('after the empty one')] })
    const r = await run.send([user('one')])
    assertEquals(r.status, 'completed')
    assertEquals(run.drv.text(r), 'after the empty one')
    assertEquals(run.tg.events('unowned_inference').length, 0)
  })
})

Deno.test('a turn that cannot be written to Claude Code fails its response instead of crashing the gateway', async () => {
  const run = new Run('stdin-broken', false)
  await run.run(async () => {
    run.fake.reply({ blocks: [text('one')] }, { blocks: [text('fine')] })
    await run.turn('one')
    const lane = [...run.tg.gw.lanes.values()][0]
    lane.proc!.write = () => Promise.reject(new Error('Broken pipe (os error 32)'))
    const r = await run.send([user('two')])
    assertEquals([r.status, r.response.error.code], ['failed', 'claude_code_stdin'])
    const r2 = await run.send([user('two')])
    assertEquals([r2.status, r2.response.x_gateway.path], ['completed', 'store'])
  })
})

Deno.test("the gateway's own reasoning items may come back next to new input; foreign ones are refused", async () => {
  const run = new Run('reasoning-back', false)
  await run.run(async () => {
    run.fake.reply({ blocks: [think('plan'), call('toolu_rb', 'echo', { text: 'x' })] })
    const r1 = await run.send([user('one')])
    const mine = r1.response.output.filter((o: Json) => o.type === 'reasoning')
    assertEquals(mine.length, 2) // the thinking, then the provider record
    const base = { model: MODEL, instructions: INSTRUCTIONS, tools: TOOLS, stream: true, previous_response_id: r1.response.id }
    const out = output('toolu_rb', 'X')
    for (const bad of [{ type: 'reasoning', summary: [] }, { type: 'reasoning', summary: [], encrypted_content: 'gAAAA-from-elsewhere' }]) {
      const r = await post(run.tg.url, { ...base, input: [bad, out] })
      assertEquals([r.status, r.body?.error?.code], [400, 'unexpected_reasoning_item'])
    }
    run.fake.reply({ blocks: [text('two')] })
    const r2 = await run.send([...mine, out])
    assertEquals([r2.status, run.drv.text(r2)], ['completed', 'two'])
    // a full history that repeats a record item still uses its records
    await run.disrupt('restart-lost-store')
    const dup = r2.response.output.find((o: Json) => o.encrypted_content?.startsWith('cc2r.record.'))
    run.drv.history.push(dup)
    run.fake.reply({ blocks: [text('three')] })
    const r3 = await run.send([user('three')])
    assertEquals([r3.response.x_gateway.path, r3.response.x_gateway.records, r3.response.x_gateway.synthesized_groups], ['history', 2, 0])
  })
})

Deno.test('upstream errors map to typed failures, at once: the client owns retries', async () => {
  const run = new Run('upstream-errors', false)
  await run.run(async () => {
    const cases: [string, { status: number; type: string; message: string; inStream?: boolean }, string][] = [
      ['400', { status: 400, type: 'invalid_request_error', message: 'bad request' }, 'upstream_invalid_request'],
      ['401', { status: 401, type: 'authentication_error', message: 'invalid x-api-key' }, 'upstream_authentication_error'],
      ['429', { status: 429, type: 'rate_limit_error', message: 'slow down' }, 'rate_limit_exceeded'],
      ['500', { status: 500, type: 'api_error', message: 'boom' }, 'upstream_error'],
      ['529', { status: 529, type: 'overloaded_error', message: 'Overloaded' }, 'upstream_overloaded'],
      ['overloaded mid-stream', { status: 200, type: 'overloaded_error', message: 'Overloaded', inStream: true }, 'upstream_stream_cut'],
    ]
    for (const [label, error, code] of cases) {
      const before = run.fake.main().length
      run.fake.reply({ blocks: [text('never')], error })
      const t0 = Date.now()
      const r = await run.send([user(`fails with ${label}`)])
      assertEquals([r.status, r.response.error.code], ['failed', code], label)
      assert(Date.now() - t0 < 5000, `${label} took ${Date.now() - t0} ms`)
      assert(run.fake.main().length - before <= 2, `${label}: ${run.fake.main().length - before} requests`)
    }
    run.fake.reply({ blocks: [text('fine')] })
    assertEquals((await run.send([user('and now it works')])).status, 'completed')
  })
})

for (const unknownFirst of [false, true]) {
  Deno.test(`a call of an undefined tool gets Claude Code's own error after a hold eviction too (unknown ${unknownFirst ? 'first' : 'last'})`, async () => {
    const calls = [call('toolu_k', 'echo', { text: 'k' }), call('toolu_u', 'nonexistent', { q: 1 })]
    if (unknownFirst) calls.reverse()
    const results: Json[][] = []
    for (const evict of [false, true]) {
      const run = new Run(`unknown-${evict ? 'evicted' : 'live'}`, false)
      await run.run(async () => {
        run.fake.reply({ blocks: calls }, { blocks: [text('after')] })
        await run.send([user('go')])
        await run.tg.waitEvent('hold')
        if (evict) await run.disrupt('hold')
        const r = await run.send([output('toolu_k', 'K'), output('toolu_u', 'the client had no such tool')])
        assertEquals(r.status, 'completed')
        if (evict) assertEquals(r.response.x_gateway.resume, 'interrupted_turn')
        const msgs = run.fake.main()[1].body.messages
        results.push(msgs.flatMap((m: Json) => Array.isArray(m.content) ? m.content.filter((b: Json) => b.type === 'tool_result') : []))
      })
    }
    const [live, evicted] = results
    const byId = (rs: Json[]) => Object.fromEntries(rs.map(({ cache_control: _c, ...b }) => [b.tool_use_id, JSON.stringify(b)]))
    assertEquals(evicted.length, 2, 'one result per call')
    assertEquals(byId(evicted), byId(live))
    assert(!JSON.stringify(evicted).includes('the client had no such tool'))
    assertStringIncludes(byId(evicted).toolu_u, 'No such tool available: mcp__fn__nonexistent')
  })
}

Deno.test('a line Claude Code writes only to disk reaches the next record, through a live turn or a cancelled one', async () => {
  for (const cancel of [false, true]) {
    const run = new Run(`disk-only-${cancel ? 'cancel' : 'live'}`, false)
    await run.run(async () => {
      run.fake.reply({ blocks: [text('one')] })
      const r1 = await run.turn('one')
      const lane = [...run.tg.gw.lanes.values()][0]
      const extra = JSON.stringify({ type: 'custom-title', customTitle: 'disk only', sessionId: lane.sessionId })
      Deno.writeTextFileSync(lane.logFile, extra + '\n', { append: true })
      if (cancel) {
        run.fake.reply({ blocks: [text('partial'), text('rest')], gapMs: 1000 })
        const stream = await run.tg.gw.create(
          parseRequest({ model: MODEL, instructions: INSTRUCTIONS, tools: TOOLS, stream: true, previous_response_id: r1.response.id, input: [user('two')] }),
        )
        const reader = stream.getReader()
        let seen = ''
        while (!seen.includes('output_text.delta')) seen += new TextDecoder().decode((await reader.read()).value)
        lane.cancel(lane.active!.state.id, 'test')
        await lane.gone
        assertEquals(run.tg.gw.store.tail(r1.response.id), [extra])
      }
      run.fake.reply({ blocks: [text('two')] })
      const r2 = await run.turn('two')
      const rec2 = (await decodeRecord(r2.response.output.at(-1).encrypted_content))!
      assertEquals(rec2.entries[0], extra)
      const live = [...run.tg.gw.lanes.values()][0]
      await live.kill('test')
      const rec1 = (await decodeRecord(r1.response.output.at(-1).encrypted_content))!
      assertEquals(Deno.readTextFileSync(live.logFile).split('\n').filter(Boolean), [...rec1.entries, ...rec2.entries])
      assertEquals(run.tg.events('verify_error').length, 0)
    })
  }
})

Deno.test('a gateway that died without cleaning up has its Claude Code processes killed at the next start; a reused pid is spared', async () => {
  const { alive, TestGateway } = await import('./harness.ts')
  const run = new Run('orphans', false)
  await run.run(async () => {
    run.fake.reply({ blocks: [text('one')] })
    await run.turn('one')
    const pid = run.tg.events('spawn')[0].data.pid
    const epoch = run.tg.events('spawn')[0].data.epoch
    const runDir = `${Deno.realPathSync(run.d.stateDir)}/run`
    while (
      !(() => {
        try {
          return Deno.statSync(`${runDir}/${epoch}/proc.json`).isFile
        } catch {
          return false
        }
      })()
    ) await new Promise((r) => setTimeout(r, 20))
    // a process that merely reuses a recorded pid (a different start time) must survive the sweep
    const bystander = new Deno.Command('/bin/sleep', { args: ['30'] }).spawn()
    Deno.mkdirSync(`${runDir}/ep_bystander`)
    Deno.writeTextFileSync(`${runDir}/ep_bystander/proc.json`, JSON.stringify({ pid: bystander.pid, started: 'Thu Jan  1 00:00:00 1970', comm: '/bin/sleep' }))
    // the first gateway "crashes": a second one starts on the same state while its process still runs
    assert(alive(pid))
    const second = await TestGateway.start({ dirs: run.d, backendEnv: run.backend() })
    for (let i = 0; i < 100 && alive(pid); i++) await new Promise((r) => setTimeout(r, 20)) // until it is reaped
    assert(!alive(pid), 'the orphan was killed')
    assert(alive(bystander.pid), 'the bystander survived')
    bystander.kill('SIGKILL')
    await bystander.status
    assertEquals([...Deno.readDirSync(runDir)].map((d) => d.name), [])
    await second.close()
  })
})

Deno.test('off loopback the gateway refuses to start without a token; with one, every request must carry it', async () => {
  const { parseArgs, ConfigError } = await import('../src/config.ts')
  const { CLAUDE, TestGateway } = await import('./harness.ts')
  const base = ['--state-dir', '/tmp/x', '--work-root', '/tmp/y', '--claude', CLAUDE]
  assertThrows(() => parseArgs(['--listen', '0.0.0.0:18399', ...base], {}), ConfigError, 'reachable beyond this machine')
  assertThrows(() => parseArgs(['--listen', '0.0.0.0:18399', '--auth-token-env', 'GW_TOKEN', ...base], {}), ConfigError, 'not set')
  assertEquals(parseArgs(['--listen', '0.0.0.0:18399', '--auth-token-env', 'GW_TOKEN', ...base], { GW_TOKEN: 's3cret' }).authToken, 's3cret')
  assertEquals(parseArgs(['--listen', '127.0.0.1:18399', ...base], {}).authToken, undefined)
  const run = new Run('auth', false)
  run.tg = await TestGateway.start({ dirs: run.d, backendEnv: run.backend(), authToken: 's3cret' })
  run.gateways.push(run.tg)
  await run.run(async () => {
    for (const auth of [undefined, 'Bearer wrong']) {
      const res = await fetch(`${run.tg.url}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) },
        body: '{}',
      })
      assertEquals([res.status, (await res.json()).error.code], [401, 'invalid_api_key'])
    }
    const { Driver } = await import('./harness.ts')
    run.drv = new Driver(run.tg.client, { instructions: INSTRUCTIONS, tools: TOOLS, model: MODEL, mode: 'previous' })
    run.fake.reply({ blocks: [text('authorized')] })
    assertEquals(run.drv.text(await run.turn('hello')), 'authorized')
  }, false)
})

Deno.test('a completed call keeps its real output in a rebuilt history, even when the next request drops its tool', async () => {
  const run = new Run('tool-dropped', false)
  await run.run(async () => {
    run.fake.reply({ blocks: [call('toolu_read', 'read', { name: 'notes' })] }, { blocks: [text('read it')] })
    await run.turn('read the notes')
    // the next request offers only echo: a new chain, so the full history goes in, synthesized
    run.drv.opts.tools = TOOLS.filter((t) => t.name === 'echo')
    run.fake.reply({ blocks: [text('fine')] })
    const r = await run.send([user('what did the notes say?')])
    assertEquals([r.status, r.response.x_gateway.path, r.response.x_gateway.records], ['completed', 'history', 0])
    const sent = JSON.stringify(run.fake.main().at(-1)!.body.messages)
    assertStringIncludes(sent, 'CONTENT OF notes')
    assert(!sent.includes('No such tool available'))
  })
})

for (const evict of [false, true]) {
  Deno.test(`blank notices are treated as absent (${evict ? 'after a hold eviction: the fixed resume line' : 'live: no hook context'})`, async () => {
    const run = new Run(`blank-notice-${evict ? 'evicted' : 'live'}`, false)
    await run.run(async () => {
      run.fake.reply({ blocks: [call('toolu_b', 'echo', { text: 'b' })] }, { blocks: [text('done')] })
      await run.send([user('go')])
      await run.tg.waitEvent('hold')
      if (evict) await run.disrupt('hold')
      const r = await run.send([output('toolu_b', 'B'), { role: 'user', content: '' }, { role: 'user', content: [] }, { role: 'user', content: '  \n ' }])
      assertEquals(r.status, 'completed')
      assertEquals(run.tg.events('notice').length, 0)
      const last = run.fake.main()[1].body.messages.at(-1)
      if (evict) {
        assertEquals(last.content.map((b: Json) => b.type), ['tool_result', 'text'])
        assertEquals(last.content[1].text, RESUME_LINE)
      } else {
        assertEquals(last.role, 'user')
        assertEquals(last.content.map((b: Json) => b.type), ['tool_result'])
      }
    })
  })
}

Deno.test('the README documents every error code the gateway can answer with', async () => {
  const { ERROR_CODES } = await import('../src/errors.ts')
  const { REPO } = await import('./harness.ts')
  const readme = Deno.readTextFileSync(`${REPO}/README.md`)
  const missing = ERROR_CODES.filter((c) => !readme.includes(`\`${c}\``))
  assertEquals(missing, [])
})

Deno.test('cancel: an unknown id is 404 not_found, a finished response 409 response_not_in_progress', async () => {
  const run = new Run('cancel-codes', false)
  await run.run(async () => {
    run.fake.reply({ blocks: [text('done')] })
    const r = await run.turn('one')
    for (const [id, status, code] of [['resp_0123456789abcdef0123456789abcdef', 404, 'not_found'], [r.response.id, 409, 'response_not_in_progress']] as const) {
      const res = await fetch(`${run.tg.url}/v1/responses/${id}/cancel`, { method: 'POST' })
      assertEquals([res.status, (await res.json()).error.code], [status, code])
    }
  })
})

Deno.test('the record timeout never covers the end-of-turn hook round trip or a slow first byte of the continuation', async () => {
  const run = new Run('slow-continuation-start', false, { recordTimeoutMs: 800 })
  await run.run(async () => {
    run.fake.reply(
      { blocks: [call('toolu_k', 'echo', { text: 'k' }), call('toolu_u', 'nonexistent', {})] },
      { blocks: [text('first part')] },
      { blocks: [text(' and the rest')], delayMs: 2000 },
    )
    await run.send([user('T1')])
    const r = await run.send([output('toolu_k', 'K'), output('toolu_u', 'unknown tool'), user('NOTICE-STOP')])
    assertEquals(r.status, 'completed', JSON.stringify(r.response.error))
    assertEquals(run.drv.text(r), 'first part and the rest')
  })
})

Deno.test('input with nothing new in it is refused, not sent as an empty turn', async () => {
  const run = new Run('nothing-new', false)
  await run.run(async () => {
    run.fake.reply({ blocks: [think('p'), text('one')] })
    const r1 = await run.turn('one')
    const mine = r1.response.output.filter((o: Json) => o.type === 'reasoning')
    const base = { model: MODEL, instructions: INSTRUCTIONS, tools: TOOLS, stream: true, previous_response_id: r1.response.id }
    for (const input of [mine, [{ role: 'user', content: '' }], [{ role: 'user', content: [] }], [{ role: 'user', content: '   ' }]]) {
      const r = await post(run.tg.url, { ...base, input })
      assertEquals([r.status, r.body?.error?.code], [400, 'invalid_request'], JSON.stringify(input).slice(0, 80))
      assertStringIncludes(r.body.error.message, 'nothing new')
    }
    assertEquals(run.fake.main().length, 1)
  })
})

// Regression tests for the M1 review findings.
import { assert, assertEquals, assertRejects, assertThrows } from '@std/assert'
import { decodeRecord, encodeRecord } from '../src/records.ts'
import { parseRequest } from '../src/api/request.ts'
import { call, type Json, text } from './fake.ts'
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

// Regression tests for the M1 review findings.
import { assert, assertEquals, assertRejects, assertThrows } from '@std/assert'
import { decodeRecord, encodeRecord } from '../src/records.ts'
import { call, type Json, text } from './fake.ts'
import { freePort, user } from './harness.ts'
import { INSTRUCTIONS, MODEL, Run, TOOLS } from './scenario.ts'

async function post(url: string, body: Json) {
  const res = await fetch(`${url}/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  if (res.headers.get('content-type')?.includes('event-stream')) {
    await res.body?.cancel()
    return { status: res.status, body: null }
  }
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

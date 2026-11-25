import { assert, assertEquals, assertMatch } from '@std/assert'
import { fileURLToPath } from 'node:url'
import { lines } from '../src/claude/lines.ts'
import { WsClient } from './websocket_client.ts'

const main = fileURLToPath(new URL('../src/agy/main.ts', import.meta.url))
const fixture = fileURLToPath(new URL('./fixtures/fake_agy.ts', import.meta.url))
const tool = (name = 'lookup') => ({ type: 'function', name, parameters: { type: 'object', properties: {} } })
const message = (role: string, content: unknown) => ({ role, content })
const initial = (input: string, tools = [tool()]) => ({ instructions: 'Fence this conversation.', model: 'gemini-3.8-flash-low', tools, input })
const follow = (r: any, input: unknown[], props = {}) => ({ model: 'gemini-3.8-flash-low', previous_response_id: r.id, input, ...props })
const calls = (r: any) => r.output.filter((v: any) => v.type === 'function_call')
const text = (r: any) => r.output.find((v: any) => v.type === 'message')?.content[0].text
const result = (call: any, output: string) => ({ type: 'function_call_output', call_id: call.call_id, output })
const outputs = (r: any) => calls(r).map((c: any, i: number) => result(c, `result-${i}`))
const shellWord = (s: string) => `'${s.replaceAll("'", `'"'"'`)}'`

async function rig(mode = 'default') {
  await Deno.mkdir('.state/test', { recursive: true })
  const root = await Deno.realPath(await Deno.makeTempDir({ dir: '.state/test', prefix: 'agy-' }))
  const state = `${root}/state with spaces`
  const fake = `${root}/agy`
  await Deno.writeTextFile(fake, `#!/bin/sh\nexec ${[Deno.execPath(), 'run', '-A', fixture, mode].map(shellWord).join(' ')} "$@"\n`, { mode: 0o700 })
  const processes = new Set<Deno.ChildProcess>()
  const evidence = async () => (await Deno.readTextFile(`${state}/gemini/fake-evidence.jsonl`)).trim().split('\n').map((line) => JSON.parse(line))
  const spawn = (extra: string[] = []) => {
    const compiled = Deno.env.get('AGY_TEST_GATEWAY')
    const child = new Deno.Command(compiled ?? Deno.execPath(), {
      args: [...(compiled ? [] : ['run', '-A', main]), '--port', '0', '--state-dir', state, '--agy', fake, ...extra],
      stdout: 'null',
      stderr: 'piped',
    }).spawn()
    processes.add(child)
    void child.status.then(() => processes.delete(child))
    return child
  }
  const start = async (extra: string[] = []) => {
    const child = spawn(extra), ready = Promise.withResolvers<string>()
    const stderr: string[] = []
    const drain = (async () => {
      for await (const line of lines(child.stderr)) {
        stderr.push(line)
        const address = line.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/)?.[1]
        if (address) ready.resolve(address)
      }
      ready.reject(new Error(stderr.join('\n')))
    })()
    const url = await ready.promise
    const stop = async (signal: Deno.Signal = 'SIGTERM') => {
      if (processes.has(child)) child.kill(signal)
      const status = await child.status
      await drain
      if (signal === 'SIGTERM') assertEquals(status.code, 0, stderr.join('\n'))
    }
    const post = (body: unknown) =>
      fetch(`${url}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stream: true, ...(body as object) }),
        signal: AbortSignal.timeout(12_000),
      })
    const create = async (body: unknown) => {
      const res = await post(body)
      const raw = await res.text()
      assertEquals(res.status, 200, raw)
      const events = raw.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)))
      assertEquals(events.at(-1)?.type, 'response.completed', raw)
      return { response: events.at(-1).response, events }
    }
    return { url, child, stop, create, post, stderr }
  }
  const dispose = async () => {
    for (const child of processes) child.kill('SIGTERM')
    await Promise.all([...processes].map((p) => p.status))
    await Deno.remove(root, { recursive: true })
  }
  return { start, spawn, evidence, dispose, state }
}

async function assertStopped(pids: number[]) {
  const deadline = performance.now() + 2500
  while (true) {
    const raw = await new Deno.Command('/bin/ps', { args: ['-p', pids.join(','), '-o', 'pid=,stat='], stderr: 'null' }).output()
    const live = new TextDecoder().decode(raw.stdout).trim().split('\n').filter((l) => /\d+\s+[^Z\s]/.test(l))
    if (!live.length) return
    assert(performance.now() < deadline, `processes still running: ${live}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

const pids = (events: any[]) => events.flatMap((e) => e.kind === 'process' ? [e.agy] : e.kind === 'shim' ? [e.pid] : [])

Deno.test('agy: batch with streamed thought/text, mixed transport, ordered outputs and idempotent steering', async () => {
  const r = await rig('brief-only')
  try {
    const gw = await r.start()
    const { response: first, events } = await gw.create(initial('batch'))
    assertEquals(first.output[0].content[0].text, 'Thinking.')
    assertEquals(text(first), 'Planning.')
    assertEquals(events.filter((x) => x.type === 'response.reasoning_text.delta').map((x) => x.delta), ['Think', 'ing.'])
    assertEquals(events.find((x) => x.type === 'response.output_text.delta')?.delta, 'Planning.')
    const batch = calls(first)
    assertEquals(batch.length, 3)
    assertEquals(new Set(batch.map((c: any) => c.call_id)).size, 3)
    assertEquals(
      batch.map((c: any) => [c.name, JSON.parse(c.arguments)]),
      [0, 1, 2].map((index) => ['lookup', { index, value: ['héllo', { nested: true }, null] }]),
    )
    assertEquals(first.usage.input_tokens, 120)
    assertEquals(first.usage.output_tokens, 25)
    const usage = await (await fetch(`${gw.url}/v1/usage`)).json()
    assertEquals(usage.tier, { id: 'fake-ultra', name: 'Fake Ultra' })
    assertEquals(usage.tokens.output_tokens, 25)
    assert(!('rate_limits' in usage))
    const os = outputs(first)
    const image = await gw.post(follow(first, [...os, message('user', [{ type: 'input_image', image_url: 'data:image/png;base64,AA==' }])]))
    assertEquals(image.status, 400)
    assertEquals((await image.json()).error.code, 'unsupported')
    assertEquals((await r.evidence()).filter((e) => e.kind === 'output'), [])
    const ws = new WsClient(new WebSocket(gw.url.replace('http:', 'ws:') + '/v1/responses'))
    try {
      const next = await ws.send(
        follow(first, [...os.reverse(), message('user', 'user notice'), message('developer', 'observation'), message('system', 'system notice')]),
      )
      const response = next.response
      assertEquals(response.x_gateway.path, 'live')
      assertEquals(JSON.parse(text(response)), {
        results: ['result-0', 'result-1', 'result-2'],
        messages: [
          { userMessage: 'user notice' },
          { systemMessage: { systemMessage: 'observation' } },
          { systemMessage: { systemMessage: 'system notice' } },
        ],
      })
      const continued = await gw.create(follow(response, [message('user', 'ordinary turn')]))
      assertEquals(text(continued.response), 'answer:ordinary turn')
    } finally {
      await ws.close()
    }
    const evidence = await r.evidence()
    assertEquals(evidence.filter((e) => e.kind === 'new').length, 1)
    assertEquals(evidence.filter((e) => e.kind === 'prompt').length, 2)
    assertEquals(evidence.filter((e) => e.kind === 'output').map((e) => e.index), [0, 1, 2])
    await gw.stop()
    await assertStopped(pids(evidence))
  } finally {
    await r.dispose()
  }
})

Deno.test('agy: absent planner falls back to one call per response, without a second ACP prompt', async () => {
  const r = await rig()
  try {
    const gw = await r.start()
    let { response } = await gw.create(initial('missing-planner'))
    for (let i = 0; i < 3; i++) {
      assertEquals(calls(response).map((c: any) => JSON.parse(c.arguments).index), [i])
      ;({ response } = await gw.create(follow(response, [result(calls(response)[0], `fallback-${i}`)])))
    }
    assertEquals(JSON.parse(text(response)).results, ['fallback-0', 'fallback-1', 'fallback-2'])
    assertEquals((await r.evidence()).filter((e) => e.kind === 'prompt').length, 1)
    assertMatch(gw.stderr.join('\n'), /emitting one call/)
    await gw.stop()
  } finally {
    await r.dispose()
  }
})

Deno.test('agy: crash reaps a held process; resume posts textual results in the same workspace', async () => {
  const r = await rig()
  try {
    let gw = await r.start()
    const { response } = await gw.create(initial('batch'))
    assertEquals(calls(response).length, 3)
    const before = await r.evidence()
    await gw.stop('SIGKILL')
    gw = await r.start()
    await assertStopped(pids(before))
    const usage = await (await fetch(`${gw.url}/v1/usage`)).json()
    assertEquals(usage.plan_type, 'fake-ultra')
    assertEquals(usage.tokens.output_tokens, 25)
    const resumed = await gw.create(follow(response, [...outputs(response), message('user', 'restart notice')]))
    assertEquals(resumed.response.x_gateway.path, 'resume')
    assertMatch(text(resumed.response), /interrupted turn.*\n.*result-0[\s\S]*result-2[\s\S]*restart notice/)
    const evidence = await r.evidence()
    assertEquals(new Set(evidence.filter((e) => e.kind === 'process').map((e) => e.cwd)).size, 1)
    assertEquals(evidence.filter((e) => e.kind === 'resume').length, 1)
    assertEquals(evidence.filter((e) => e.kind === 'output').length, 0)
    assertEquals(evidence.filter((e) => e.kind === 'prompt').length, 2)
    await gw.stop()
    await assertStopped(pids(evidence))
  } finally {
    await r.dispose()
  }
})

Deno.test('agy: missing native state and a changed tool set each rebuild from client history', async () => {
  const r = await rig()
  try {
    let gw = await r.start()
    const initialResponse = (await gw.create(initial('batch'))).response
    await gw.stop()
    await Deno.remove(`${r.state}/gemini/antigravity-cli/conversations`, { recursive: true })
    gw = await r.start()
    const rebuilt = await gw.create(follow(initialResponse, outputs(initialResponse)))
    assertEquals(rebuilt.response.x_gateway.path, 'history')
    assertMatch(text(rebuilt.response), /client history[\s\S]*"batch"[\s\S]*Planning\.[\s\S]*result-2/)
    const next = await gw.create(follow(rebuilt.response, [message('user', 'fresh tools')], { tools: [tool('another')] }))
    assertEquals(next.response.x_gateway.path, 'history')
    const evidence = await r.evidence()
    assertEquals(evidence.filter((e) => e.kind === 'resume').length, 1)
    assertEquals(evidence.filter((e) => e.kind === 'listed').map((e) => e.names), [['lookup'], ['lookup'], ['another']])
    await gw.stop()
    await assertStopped(pids(evidence))
  } finally {
    await r.dispose()
  }
})

Deno.test('agy: reject an unchecked version, and refuse a default-agent fallback before prompt', async () => {
  const wrong = await rig('version')
  try {
    const child = wrong.spawn()
    const out = await child.output()
    assertEquals(out.code, 2)
    assertMatch(new TextDecoder().decode(out.stderr), /agy version 9\.9\.9 is not checked/)
    const gw = await wrong.start(['--allow-untested-agy'])
    await gw.stop()
  } finally {
    await wrong.dispose()
  }
  const fallback = await rig('fallback-agent')
  try {
    const gw = await fallback.start()
    const failure = await gw.post(initial('do not send'))
    assertEquals(failure.status, 500)
    assertMatch((await failure.json()).error.message, /default agent; no prompt was sent/)
    const evidence = await fallback.evidence()
    assertEquals(evidence.filter((e) => e.kind === 'prompt').length, 0)
    await gw.stop()
    await assertStopped(pids(evidence))
  } finally {
    await fallback.dispose()
  }
})

Deno.test('agy: parallel lanes list only their own tools; an evicted hold resumes from the durable response', async () => {
  const r = await rig()
  try {
    const gw = await r.start(['--hold-timeout', '0.2'])
    const [{ response: first }, { response: second }] = await Promise.all([
      gw.create(initial('batch', [tool('first')])),
      gw.create(initial('batch', [tool('second')])),
    ])
    assertEquals(calls(first).map((call: any) => call.name), ['first', 'first', 'first'])
    assertEquals(calls(second).map((call: any) => call.name), ['second', 'second', 'second'])
    const before = await r.evidence()
    assertEquals(new Set(before.filter((e) => e.kind === 'process').map((e) => e.cwd)).size, 2)
    await assertStopped(pids(before))
    const resumed = await gw.create(follow(second, outputs(second)))
    assertEquals(resumed.response.x_gateway.path, 'resume')
    assertMatch(text(resumed.response), /"name":"second".*"output":"result-2"/)
    await gw.stop()
    await assertStopped(pids(await r.evidence()))
  } finally {
    await r.dispose()
  }
})

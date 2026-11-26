// The agy lane's per-release probe, against the real agy. `AGY_BINARY` names it (default: agy on PATH).
//
// It runs the same conversation twice on a plain-http pass-through capture of agy's upstream endpoint
// (`--cloud_code_endpoint`): once live, and once with an eviction, a gateway restart that keeps the store, and a
// restart that lost the whole state folder. Every request's system instruction and tools must be byte-identical, and
// each request's `contents` must start with the previous request's: the cache prefix survives every rebuild.
// Nothing but request bodies is recorded; Authorization, cookies and tokens are never read or printed.
import { assert, assertEquals, assertMatch } from '@std/assert'
import { fileURLToPath } from 'node:url'
import { lines } from '../src/claude/lines.ts'

const main = fileURLToPath(new URL('../src/agy/main.ts', import.meta.url))
const home = Deno.env.get('HOME') ?? ''
const agy = Deno.env.get('AGY_BINARY') ?? `${home}/.local/bin/agy`
const available = (() => {
  try {
    return Deno.statSync(agy).isFile
  } catch {
    return false
  }
})()

const MODEL = 'gemini-3.8-flash-low'
const INSTRUCTIONS = 'You are a helpful assistant in a probe. Answer in one short sentence.'
const tool = { type: 'function', name: 'echo', parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } }
const user = (text: string) => ({ role: 'user', content: text })
const message = (role: string, content: unknown) => ({ role, content })
const result = (call: any, output: string) => ({ type: 'function_call_output', call_id: call.call_id, output })
const shellWord = (s: string) => `'${s.replaceAll("'", `'"'"'`)}'`

/** A pass-through capture: agy's upstream endpoint stays https, only its entry point is plain http loopback. */
function upstreamProxy() {
  const bodies: any[] = []
  const server = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen: () => {} }, async (req) => {
    const url = new URL(req.url)
    const body = req.method === 'POST' ? await req.text() : ''
    if (body) {
      try {
        bodies.push({ path: url.pathname, json: JSON.parse(body) })
      } catch { /* a non-JSON body is not a generate request */ }
    }
    const upstream = await fetch(`https://daily-cloudcode-pa.googleapis.com${url.pathname}${url.search}`, {
      method: req.method,
      headers: new Headers([...req.headers].filter(([key]) => !['host', 'content-length'].includes(key.toLowerCase()))),
      body: req.method === 'POST' ? body : undefined,
      redirect: 'manual',
    })
    // fetch has already decoded the body: the upstream's encoding and length headers no longer describe it
    const headers = new Headers([...upstream.headers].filter(([key]) => !['content-encoding', 'content-length'].includes(key.toLowerCase())))
    return new Response(upstream.body, { status: upstream.status, headers })
  })
  return { url: `http://127.0.0.1:${server.addr.port}`, bodies, close: () => server.shutdown() }
}

const normalize = (text: string) =>
  text
    .replace(/The current local time is: [^.\n]*/g, 'The current local time is: T')
    .replace(/timestamp=[^ \n]*/g, 'timestamp=T')

/** One gateway run: a temp state dir, the real agy behind a capture, and a conversation driver. */
async function rig(proxy: string, extra: string[] = []) {
  const root = await Deno.realPath(await Deno.makeTempDir({ prefix: 'agy-probe-' }))
  const state = `${root}/state`
  const wrapper = `${root}/agy`
  // agy takes the endpoint override as an option of its `acp` subcommand, after the subcommand's own flags.
  await Deno.writeTextFile(
    wrapper,
    `#!/bin/sh\nif [ "$1" = "acp" ]; then shift; exec ${shellWord(agy)} acp --cloud_code_endpoint ${shellWord(proxy)} "$@"; fi\nexec ${shellWord(agy)} "$@"\n`,
    { mode: 0o700 },
  )
  const processes = new Set<Deno.ChildProcess>()
  const start = async () => {
    const child = new Deno.Command(Deno.execPath(), {
      args: ['run', '-A', main, '--port', '0', '--state-dir', state, '--agy', wrapper, ...extra],
      stdout: 'null',
      stderr: 'piped',
    }).spawn()
    processes.add(child)
    void child.status.then(() => processes.delete(child))
    const ready = Promise.withResolvers<string>()
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
    const stop = async () => {
      if (processes.has(child)) child.kill('SIGTERM')
      const status = await child.status
      await drain.catch(() => {/* expected once the process is gone */})
      assertEquals(status.code, 0, stderr.join('\n'))
    }
    const create = async (body: unknown) => {
      const res = await fetch(`${url}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stream: true, ...(body as object) }),
        signal: AbortSignal.timeout(180_000),
      })
      const raw = await res.text()
      assertEquals(res.status, 200, raw.slice(0, 2000))
      const events = raw.split('\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)))
      const response = events.at(-1)?.response
      assert(response, raw.slice(-2000))
      return response
    }
    /** Waits until no lane holds a process (`/healthz` counts them). */
    const idle = async () => {
      for (let i = 0; i < 100; i++) {
        const health = await (await fetch(`${url}/healthz`)).json()
        if (health.lanes === 0) return
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      throw new Error('the gateway still holds a lane')
    }
    return { url, stop, create, idle }
  }
  const dispose = async () => {
    for (const child of processes) child.kill('SIGTERM')
    await Promise.all([...processes].map((p) => p.status))
    await Deno.remove(root, { recursive: true })
  }
  return { start, dispose, state }
}

Deno.test({
  name: 'agy upstream: live, store-rebuilt and history-rebuilt requests keep one system instruction, tools and prefix',
  ignore: !available,
  fn: async () => {
    const proxy = upstreamProxy()
    const r = await rig(proxy.url, ['--hold-timeout', '0.5'])
    try {
      let gw = await r.start()
      const history: any[] = []
      const send = async (input: any[], previous: string | null) => {
        const body = { model: MODEL, instructions: INSTRUCTIONS, tools: [tool], input: previous ? input : [...history, ...input] }
        const response = await gw.create(previous ? { ...body, previous_response_id: previous } : body)
        assertEquals(response.status, 'completed')
        history.push(...input, ...response.output)
        return response
      }
      const first = await send([user('Remember marker PROBE-7731.')], null)
      const second = await send([user('Call echo with value ALPHA, then tell me the result.')], first.id)
      assertEquals(second.x_gateway.path, 'live')
      const calls = second.output.filter((item: any) => item.type === 'function_call')
      assertEquals(calls.length, 1, 'the model did not call the tool')
      // the held process is evicted by the hold timeout: the outputs are written into the step and resumed
      await gw.idle()
      const third = await send([result(calls[0], 'ECHO ALPHA echoed'), user('Also remember KIWI-5502.')], second.id)
      assertEquals([third.x_gateway.path, third.x_gateway.patched], ['store', 1])
      await gw.stop()
      gw = await r.start()
      const fourth = await send([user('Name both markers.')], third.id)
      assertEquals(fourth.x_gateway.path, 'store')
      await gw.stop()
      await Deno.remove(r.state, { recursive: true })
      gw = await r.start()
      const fifth = await send([user('In one line: what did echo return, and both markers?')], null)
      assertEquals(fifth.x_gateway.path, 'history')
      assertMatch(fifth.output.filter((item: any) => item.type === 'message').map((item: any) => item.content[0].text).join(''), /PROBE-7731/)
      await gw.stop()
    } finally {
      await r.dispose()
      await proxy.close()
    }
    // the agent's own inferences only: agy also asks a title generator, which is not this conversation
    const generate = proxy.bodies.filter((body) => body.json?.requestType === 'custom_agent' && body.json?.request?.contents)
    assert(generate.length >= 5, `only ${generate.length} generate requests were captured`)
    const instructions = generate.map((g) => typeof g.json.request.systemInstruction === 'string' ? g.json.request.systemInstruction : JSON.stringify(g.json.request.systemInstruction))
    const baseline = instructions[0]
    const differing = instructions.findIndex((text) => text !== baseline)
    if (differing > 0) {
      const other = instructions[differing]
      let at = 0
      while (at < baseline.length && baseline[at] === other[at]) at++
      console.error(`system instruction differs in request ${differing} at ${at} of ${baseline.length}/${other.length}:`)
      console.error(`  ${JSON.stringify(baseline.slice(Math.max(0, at - 60), at + 120))}`)
      console.error(`  ${JSON.stringify(other.slice(Math.max(0, at - 60), at + 120))}`)
    }
    assertEquals(differing, -1, 'the system instruction changed across the conversation')
    const tools = new Set(generate.map((g) => JSON.stringify(g.json.request.tools)))
    assertEquals(tools.size, 1, 'the tool declarations changed across the conversation')
    const contents = generate.map((g) => g.json.request.contents.map((part: any) => normalize(JSON.stringify(part))))
    for (let i = 1; i < contents.length; i++) {
      const previous = contents[i - 1]
      const current = contents[i]
      assert(current.length >= previous.length, `request ${i} has ${current.length} contents, request ${i - 1} had ${previous.length}`)
      for (let j = 0; j < previous.length; j++) {
        assertEquals(current[j], previous[j], `request ${i} changed prior content ${j}`)
      }
    }
  },
})

// The agy lane's per-release probe, against the real agy. `AGY_BINARY` names it (default: agy on PATH).
//
// What it runs: one conversation per transport — HTTP/SSE, then a persistent WebSocket — against a plain-http
// pass-through capture of agy's upstream endpoint (`--cloud_code_endpoint`). Each conversation is: a plain turn, a
// tool batch held until the gateway's hold timeout evicts the process, the outputs released into a store rebuilt from
// the records, a gateway restart that keeps the state folder, and finally the whole state folder deleted with the
// client's full history sent instead. Every response must complete.
//
// Assertions, per conversation and over all captured agent requests: one system instruction (the chain, the workspace
// and the conversation id it names stay the same, the deleted-state rebuild included), one tool set, and each
// request's `contents` starting with the previous request's. The two transports run two conversations, so their
// instructions differ only in those three names. The Wuhu session past 190 KB over both transports is the post-merge
// trial, not this probe. Nothing but request bodies is recorded; Authorization, cookies and tokens are never read or
// printed.
import { assert, assertEquals, assertMatch } from '@std/assert'
import { fileURLToPath } from 'node:url'
import { lines } from '../src/claude/lines.ts'
import { WsClient } from '../test/websocket_client.ts'

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
const result = (call: any, output: string) => ({ type: 'function_call_output', call_id: call.call_id, output })
const shellWord = (s: string) => `'${s.replaceAll("'", `'"'"'`)}'`
const calls = (response: any) => (response.output ?? []).filter((item: any) => item.type === 'function_call')
const textOf = (response: any) => (response.output ?? []).filter((item: any) => item.type === 'message').map((item: any) => item.content[0].text).join('')

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

/** One gateway run: a temp state dir, the real agy behind a capture, and both transports. */
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
    const socket = () => new WsClient(new WebSocket(url.replace('http:', 'ws:') + '/v1/responses'))
    return { url, stop, create, idle, socket }
  }
  const dispose = async () => {
    for (const child of processes) child.kill('SIGTERM')
    await Promise.all([...processes].map((p) => p.status))
    await Deno.remove(root, { recursive: true })
  }
  return { start, dispose, state }
}

Deno.test({
  name: 'agy upstream: per conversation one system instruction, one tool set and one growing prefix, over SSE and WebSocket',
  ignore: !available,
  fn: async () => {
    const proxy = upstreamProxy()
    const r = await rig(proxy.url, ['--hold-timeout', '0.5'])
    try {
      for (const transport of ['sse', 'ws'] as const) {
        const history: any[] = []
        let gw = await r.start()
        let ws: WsClient | null = null
        const open = async () => {
          if (transport === 'ws') ws = gw.socket()
        }
        const close = async () => {
          if (ws) await ws.close()
          ws = null
        }
        const send = async (input: any[], previous: string | null) => {
          const body: any = {
            model: MODEL,
            instructions: INSTRUCTIONS,
            tools: [tool],
            input: previous ? input : [...history, ...input],
            ...(previous ? { previous_response_id: previous } : {}),
          }
          const response = transport === 'sse' ? await gw.create(body) : (await ws!.send(body)).response
          assertEquals(response.status, 'completed', `${transport}: ${JSON.stringify(response.error)}`)
          history.push(...input, ...response.output)
          return response
        }
        await open()
        try {
          const first = await send([user('Remember the marker PROBE-7731.')], null)
          assertEquals(first.x_gateway.path, 'new', transport)
          const batch = await send([user('Call echo with value ALPHA, then tell me the result.')], first.id)
          assertEquals(calls(batch).length, 1, `${transport}: the model did not call the tool`)
          await gw.idle() // the hold timeout evicts the process: the release rebuilds from the store
          const released = await send([result(calls(batch)[0], 'ECHO ALPHA echoed'), user('Also remember KIWI-5502.')], batch.id)
          assertEquals([released.x_gateway.path, released.x_gateway.patched], ['store', 1], transport)
          await close()
          await gw.stop()
          gw = await r.start()
          await open()
          const named = await send([user('Name both markers.')], released.id)
          assertEquals(named.x_gateway.path, 'store', transport)
          assertMatch(textOf(named), /PROBE-7731/, transport)
          await close()
          await gw.stop()
          await Deno.remove(r.state, { recursive: true })
          gw = await r.start()
          await open()
          const rebuilt = await send([user('In one line: what did echo return, and both markers?')], null)
          assertEquals(rebuilt.x_gateway.path, 'history', transport)
          assertMatch(textOf(rebuilt), /PROBE-7731/, transport)
        } finally {
          await close()
          await gw.stop()
        }
      }
    } finally {
      await r.dispose()
      await proxy.close()
    }
    // the agent's own inferences only: agy also asks a title generator, which is not this conversation
    const generate = proxy.bodies.filter((body) => body.json?.requestType === 'custom_agent' && body.json?.request?.contents)
    assert(generate.length >= 8, `only ${generate.length} generate requests were captured`)
    // one conversation per transport, told apart by the chain its instruction names: the rebuild after the state
    // folder is deleted has to stay in its own conversation, which is what makes the prompt the same one again
    const instructions = generate.map((g) => JSON.stringify(g.json.request.systemInstruction))
    const conversations = new Map<string, number[]>()
    generate.forEach((_, i) => {
      const chain = /\/workspaces\/(chain_[0-9a-f]+)/.exec(instructions[i])?.[1]
      assert(chain, `request ${i} names no chain workspace`)
      conversations.set(chain, [...(conversations.get(chain) ?? []), i])
    })
    assertEquals([...conversations.values()].map((indexes) => indexes.length), [5, 5], 'one conversation of five inferences per transport')
    const tools = new Set(generate.map((g) => JSON.stringify(g.json.request.tools)))
    assertEquals(tools.size, 1, 'the tool declarations changed across the conversations')
    const contents = generate.map((g) => g.json.request.contents.map((part: any) => normalize(JSON.stringify(part))))
    for (const [chain, indexes] of conversations) {
      for (const i of indexes) assertEquals(instructions[i], instructions[indexes[0]], `the system instruction changed in request ${i} of ${chain}`)
      for (let k = 1; k < indexes.length; k++) {
        const [previous, current] = [contents[indexes[k - 1]], contents[indexes[k]]]
        assert(current.length >= previous.length, `request ${indexes[k]}: ${current.length} contents, request ${indexes[k - 1]} had ${previous.length}`)
        for (let j = 0; j < previous.length; j++) assertEquals(current[j], previous[j], `request ${indexes[k]} changed prior content ${j}`)
      }
    }
  },
})

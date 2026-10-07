// Launches Claude Code exactly as the gateway does (src/claude/pins.ts), with one pin changed at a time,
// against the fake endpoint and a scriptable MCP/hook target. Used by the per-release probe.
import { Bridge, type BridgeTarget } from '../src/bridge.ts'
import { launchArgs, launchEnv, type LaunchSpec, logPath, MAX_RESULT_CHARS, mcpConfigJson, settingsJson } from '../src/claude/pins.ts'
import type { FakeAnthropic, Json } from '../test/fake.ts'
import { CLAUDE, freePort, REPO } from '../test/harness.ts'

export interface ProbeTools {
  tools: Json[]
  call(id: string, name: string, args: Json): Promise<Json>
  hook(body: Json): Json
}

export class ProbeTarget implements BridgeTarget {
  hooks: Json[] = []
  calls: { id: string; name: string; args: Json; at: number }[] = []
  held = new Map<string, (r: Json) => void>()
  /** Text returned for each PostToolUse / Stop hook, once. */
  postToolNotice: string | null = null
  stopNotice: string | null = null
  resultFor: (name: string, args: Json) => Json | null = (_n, a) => ({ content: [{ type: 'text', text: `ECHO ${JSON.stringify(a)}` }] })
  withMeta = true
  constructor(readonly toolNames: string[] = ['echo', 'hold']) {}
  mcpTools(): Json[] {
    return this.toolNames.map((name) => ({
      name,
      description: `The ${name} tool.`,
      inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
      ...(this.withMeta ? { _meta: { 'anthropic/maxResultSizeChars': MAX_RESULT_CHARS } } : {}),
    }))
  }
  toolCall(id: string, name: string, args: Json): Promise<Json> {
    this.calls.push({ id, name, args, at: Date.now() })
    const r = name === 'hold' ? null : this.resultFor(name, args)
    if (r) return Promise.resolve(r)
    return new Promise((resolve) => this.held.set(id, resolve))
  }
  release(id: string, text: string): void {
    const r = this.held.get(id)
    this.held.delete(id)
    r?.({ content: [{ type: 'text', text }] })
  }
  hook(body: Json): Json {
    this.hooks.push(body)
    const ev = body.hook_event_name
    if ((ev === 'PostToolUse' || ev === 'PostToolUseFailure') && this.postToolNotice) {
      const t = this.postToolNotice
      this.postToolNotice = null
      return { hookSpecificOutput: { hookEventName: ev, additionalContext: t } }
    }
    if (ev === 'Stop' && this.stopNotice && !body.stop_hook_active) {
      const t = this.stopNotice
      this.stopNotice = null
      return { hookSpecificOutput: { hookEventName: 'Stop', additionalContext: t } }
    }
    return {}
  }
}

export interface ProbeOpts {
  name: string
  fake: FakeAnthropic
  target: ProbeTarget
  sessionId?: string
  resume?: boolean
  interruptedTurn?: boolean
  tz?: string
  /** Environment changes on top of the pinned environment; undefined removes a variable. */
  env?: Record<string, string | undefined>
  /** Argument replacement: (args) => args */
  args?: (a: string[]) => string[]
  workDir?: string
  /** A log to write before resuming. */
  log?: string[]
}

export class ProbeRun {
  frames: Json[] = []
  stderr = ''
  child: Deno.ChildProcess
  stdin: WritableStreamDefaultWriter<Uint8Array>
  exited: Promise<Deno.CommandStatus>
  spec: LaunchSpec
  private waiters = new Set<() => void>()

  constructor(readonly o: ProbeOpts, readonly bridge: Bridge, readonly root: string) {
    const epoch = `ep_${o.name.replace(/[^a-z0-9]/gi, '')}${Date.now()}`
    bridge.register(epoch, o.target)
    const workDir = o.workDir ?? `/tmp/cc2r-probe/${o.name}`
    Deno.mkdirSync(workDir, { recursive: true })
    const configDir = `${root}/config`, homeDir = `${root}/home`
    for (const d of [configDir, homeDir]) Deno.mkdirSync(d, { recursive: true })
    const settingsPath = `${root}/${o.name}.settings.json`, mcpConfigPath = `${root}/${o.name}.mcp.json`
    Deno.writeTextFileSync(settingsPath, JSON.stringify(settingsJson(bridge.hookUrl(epoch), bridge.bearer)))
    Deno.writeTextFileSync(mcpConfigPath, JSON.stringify(mcpConfigJson(bridge.mcpUrl(epoch), bridge.bearer)))
    this.spec = {
      binary: CLAUDE,
      sessionId: o.sessionId ?? crypto.randomUUID(),
      resume: o.resume ?? false,
      model: 'claude-opus-5-5',
      effort: 'high',
      instructions: 'You are a probe.',
      workDir: Deno.realPathSync(workDir),
      configDir,
      homeDir,
      tz: o.tz ?? 'UTC',
      settingsPath,
      mcpConfigPath,
      interruptedTurn: o.interruptedTurn ?? false,
      backendEnv: { ANTHROPIC_BASE_URL: o.fake.url, ANTHROPIC_AUTH_TOKEN: 'probe-key' },
    }
    if (o.log) {
      const p = this.logFile
      Deno.mkdirSync(p.replace(/\/[^/]+$/, ''), { recursive: true })
      Deno.writeTextFileSync(p, o.log.map((l) => l + '\n').join(''))
    }
    const env: Record<string, string> = launchEnv(this.spec)
    for (const [k, v] of Object.entries(o.env ?? {})) {
      if (v === undefined) delete env[k]
      else env[k] = v
    }
    const args = (o.args ?? ((a) => a))(launchArgs(this.spec))
    this.child = new Deno.Command(CLAUDE, { args, env, clearEnv: true, cwd: this.spec.workDir, stdin: 'piped', stdout: 'piped', stderr: 'piped' }).spawn()
    this.stdin = this.child.stdin.getWriter()
    const d = Promise.all([this.readOut(), this.readErr()])
    this.exited = this.child.status.then(async (s) => {
      await d
      this.wake()
      bridge.unregister(epoch)
      return s
    })
  }

  get logFile(): string {
    return logPath(this.spec.configDir, this.spec.workDir, this.spec.sessionId)
  }

  log(): string[] {
    try {
      return Deno.readTextFileSync(this.logFile).split('\n').filter(Boolean)
    } catch {
      return []
    }
  }

  async user(text: string): Promise<void> {
    await this.stdin.write(
      new TextEncoder().encode(
        JSON.stringify({ type: 'user', session_id: '', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n',
      ),
    )
  }

  async until(pred: (f: Json) => boolean, ms = 30000, from = 0): Promise<Json> {
    const deadline = Date.now() + ms
    let i = from
    let done = false
    this.exited.then(() => (done = true))
    while (true) {
      for (; i < this.frames.length; i++) if (pred(this.frames[i])) return this.frames[i]
      if (done) throw new Error(`exited while waiting: ${this.stderr.slice(-500)}`)
      const left = deadline - Date.now()
      if (left <= 0) throw new Error(`timeout after ${ms} ms`)
      await new Promise<void>((res) => {
        const t = setTimeout(fin, left)
        this.waiters.add(fin)
        function fin() {
          clearTimeout(t)
          res()
        }
      })
    }
  }

  async turn(text: string, ms = 30000): Promise<Json> {
    const from = this.frames.length
    await this.user(text)
    return await this.until((f) => f.type === 'result', ms, from)
  }

  async kill(): Promise<void> {
    try {
      this.child.kill('SIGKILL')
    } catch { /* gone */ }
    await this.exited
  }

  private wake() {
    for (const w of [...this.waiters]) {
      this.waiters.delete(w)
      w()
    }
  }
  private async readOut() {
    for await (const l of lines(this.child.stdout)) {
      try {
        this.frames.push(JSON.parse(l))
      } catch { /* not json */ }
      this.wake()
    }
  }
  private async readErr() {
    for await (const l of lines(this.child.stderr)) this.stderr += l + '\n'
  }
}

async function* lines(stream: ReadableStream<Uint8Array>) {
  const dec = new TextDecoder()
  let buf = ''
  for await (const chunk of stream) {
    buf += dec.decode(chunk, { stream: true })
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const l = buf.slice(0, i)
      buf = buf.slice(i + 1)
      if (l) yield l
    }
  }
}

export class Probe {
  bridge = new Bridge(freePort())
  root = `${REPO}/.state/probe/${Date.now().toString(36)}`
  runs: ProbeRun[] = []
  launch(o: ProbeOpts): ProbeRun {
    const r = new ProbeRun(o, this.bridge, this.root)
    this.runs.push(r)
    return r
  }
  async close(): Promise<void> {
    await Promise.all(this.runs.map((r) => r.kill()))
    // a held call keeps its HTTP request open, and the server only shuts down once every request is answered
    for (const r of this.runs) for (const id of [...r.o.target.held.keys()]) r.o.target.release(id, 'probe closed')
    await this.bridge.close()
    try {
      Deno.removeSync('/tmp/cc2r-probe', { recursive: true })
    } catch { /* gone */ }
  }
}

export const without = (flag: string, takesValue = true) => (a: string[]) => {
  const i = a.indexOf(flag)
  if (i < 0) return a
  return [...a.slice(0, i), ...a.slice(i + (takesValue ? 2 : 1))]
}

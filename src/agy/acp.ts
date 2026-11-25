import { spawn } from 'node:child_process'
import { Readable } from 'node:stream'
import { kill as signalProcess } from 'node:process'
import { lines } from '../claude/lines.ts'
import { GatewayError, serverError } from '../errors.ts'
import { AGY_ENV, type JsonObject, object, rpc, rpcError, rpcId, string } from './wire.ts'

const encoder = new TextEncoder()
export const agentName = (chain: string) => `responses-${chain.slice(-24)}`
const launchArgs = (gemini: string, chain: string) => ['acp', '--stdio', '--gemini-dir', gemini, '--agent', agentName(chain)]

/** Callers cannot provide a shell command. Helpers inherit only the host/user environment and the lane credentials. */
export function agyEnvironment(extra: Record<string, string> = {}): Record<string, string> {
  const env = Object.fromEntries(Object.entries(Deno.env.toObject()).filter(([key]) => /^(HOME|PATH|USER|LOGNAME|TMPDIR|TMP|TEMP|LANG|LC_\w+)$/.test(key)))
  return { ...env, ...AGY_ENV, ...extra }
}

function killGroup(pid: number) {
  try {
    signalProcess(-pid, 'SIGKILL')
  } catch (e) {
    if (!(e instanceof Error && 'code' in e && e.code === 'ESRCH')) throw e
  }
}

/** The dedicated, detached agy group also owns the shim and hook. A random workspace/agent id is
 * persisted before launch; matching the complete pinned argv suffix closes the spawn-to-registry crash gap. */
export async function reapOrphans(gemini: string, chains: Set<string>): Promise<void> {
  if (!chains.size) return
  const suffixes = new Set([...chains].map((chain) => ` ${launchArgs(gemini, chain).join(' ')}`))
  const pids = async () => {
    const out = await new Deno.Command('/bin/ps', { args: ['-ww', '-axo', 'pid=,pgid=,command='], stderr: 'null' }).output()
    if (!out.success) throw new Error('could not inspect existing agy processes')
    const found: number[] = []
    for (const line of new TextDecoder().decode(out.stdout).split('\n')) {
      const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
      if (!match || match[1] !== match[2]) continue
      const argv = match[3], start = argv.lastIndexOf(' acp --stdio --gemini-dir ')
      if (start !== -1 && suffixes.has(argv.slice(start))) found.push(Number(match[1]))
    }
    return found
  }
  const stale = await pids()
  for (const pid of stale) killGroup(pid)
  if (stale.length) {
    const deadline = performance.now() + 1500
    while ((await pids()).length) {
      if (performance.now() >= deadline) throw new Error('could not reap the old agy process group')
      await new Promise((resolve) => setTimeout(resolve, 15))
    }
  }
}

export class AcpError extends GatewayError {
  constructor(readonly rpcCode: number, readonly method: string) {
    super(502, 'server_error', 'upstream_error', `agy rejected ${method} (ACP ${rpcCode}).`)
  }
}

class Deferred<T> {
  readonly promise: Promise<T>
  resolve!: (value: T) => void
  reject!: (error: unknown) => void
  constructor() {
    this.promise = new Promise((resolve, reject) => {
      this.resolve = resolve
      this.reject = reject
    })
  }
}

export class AcpProcess {
  readonly pid: number
  readonly startedAt = Date.now()
  readonly stopped: Promise<void>
  private child: ReturnType<typeof spawn>
  private id = 0
  private pending = new Map<number, { reply: Deferred<JsonObject>; method: string }>()
  private dead = false

  constructor(
    spec: { agy: string; cwd: string; gemini: string; chain: string; token: string; origin: string },
    private notify: (method: string, params: JsonObject) => void,
    private permit: (params: JsonObject) => object,
    private onExit: (error: unknown) => void,
  ) {
    const child = this.child = spawn(spec.agy, launchArgs(spec.gemini, spec.chain), {
      detached: true,
      cwd: spec.cwd,
      stdio: ['pipe', 'pipe', 'ignore'],
      env: agyEnvironment({ AGY_RESPONSES_LANE: spec.token, AGY_RESPONSES_ORIGIN: spec.origin }),
    })
    this.pid = child.pid ?? 0
    child.stdin?.on('error', () => this.stop())
    this.stopped = new Promise((resolve) => {
      const ended = () => {
        this.stop()
        resolve()
      }
      child.once('error', ended)
      child.once('exit', ended)
    })
    void this.read().catch((e) => this.stop(e))
  }

  async request(method: string, params: JsonObject, timeoutMs?: number): Promise<JsonObject> {
    if (this.dead) throw serverError('upstream_unreachable', 'The agy process is closed.')
    const id = ++this.id
    const reply = new Deferred<JsonObject>()
    this.pending.set(id, { method, reply })
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
      reply.reject(serverError('upstream_unreachable', `agy did not answer ${method}.`))
    }, timeoutMs)
    try {
      this.write({ jsonrpc: '2.0', id, method, params })
      return await reply.promise
    } finally {
      clearTimeout(timer)
      this.pending.delete(id)
    }
  }

  stop(err: unknown = serverError('upstream_unreachable', 'The agy process exited.')): void {
    if (this.dead) return
    this.dead = true
    if (this.pid) killGroup(this.pid)
    this.child.stdin?.destroy()
    for (const { reply } of this.pending.values()) reply.reject(err)
    this.onExit(err)
  }

  private write(value: unknown) {
    this.child.stdin!.write(encoder.encode(JSON.stringify(value) + '\n'))
  }

  private async read() {
    for await (const line of lines(Readable.toWeb(this.child.stdout!) as ReadableStream<Uint8Array>)) {
      if (this.dead) break
      const msg = object(JSON.parse(line))
      if (!msg) continue
      const method = string(msg.method), id = rpcId(msg.id), params = object(msg.params) ?? {}
      if (method && id !== undefined) {
        this.write(method === 'session/request_permission' ? rpc(id, this.permit(params)) : rpcError(id, -32601, 'Method not found'))
      } else if (method) this.notify(method, params)
      else if (typeof id === 'number') {
        const pending = this.pending.get(id)
        if (!pending) continue
        const err = object(msg.error)
        if (err) pending.reply.reject(new AcpError(typeof err.code === 'number' ? err.code : -32603, pending.method))
        else pending.reply.resolve(object(msg.result) ?? {})
      }
    }
  }
}

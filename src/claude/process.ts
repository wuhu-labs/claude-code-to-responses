// One Claude Code child process: stream-json in and out, killed with SIGKILL.
import { launchArgs, launchEnv, type LaunchSpec } from './pins.ts'

// deno-lint-ignore no-explicit-any
export type Frame = any

export class ClaudeProcess {
  readonly child: Deno.ChildProcess
  readonly pid: number
  readonly exited: Promise<Deno.CommandStatus>
  private stdin: WritableStreamDefaultWriter<Uint8Array>
  private stderrTail = ''
  private killed = false

  /** `onError` gets every exception a frame handler throws: none is swallowed. */
  constructor(spec: LaunchSpec, onFrame: (f: Frame) => void, onExit: (s: Deno.CommandStatus) => void, onError: (e: unknown) => void) {
    this.child = new Deno.Command(spec.binary, {
      args: launchArgs(spec),
      env: launchEnv(spec),
      clearEnv: true,
      cwd: spec.workDir,
      stdin: 'piped',
      stdout: 'piped',
      stderr: 'piped',
    }).spawn()
    this.pid = this.child.pid
    this.stdin = this.child.stdin.getWriter()
    const out = this.readOut(onFrame, onError)
    const err = this.readErr()
    this.exited = this.child.status.then(async (s) => {
      await Promise.allSettled([out, err])
      onExit(s)
      return s
    })
  }

  get stderr(): string {
    return this.stderrTail
  }

  async write(msg: unknown): Promise<void> {
    await this.stdin.write(new TextEncoder().encode(JSON.stringify(msg) + '\n'))
  }

  kill(): Promise<Deno.CommandStatus> {
    if (!this.killed) {
      this.killed = true
      try {
        this.child.kill('SIGKILL')
      } catch { /* already gone */ }
    }
    return this.exited
  }

  private async readOut(onFrame: (f: Frame) => void, onError: (e: unknown) => void) {
    for await (const line of lines(this.child.stdout)) {
      let f: Frame
      try {
        f = JSON.parse(line)
      } catch {
        continue
      }
      try {
        onFrame(f)
      } catch (e) {
        onError(e)
      }
    }
  }

  private async readErr() {
    for await (const line of lines(this.child.stderr)) {
      this.stderrTail = (this.stderrTail + line + '\n').slice(-8192)
    }
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
  buf += dec.decode()
  if (buf) yield buf
}

/**
 * A process's start time and executable as `ps` reports them (never its arguments: they are not printed), so a
 * recorded pid is only ever matched with the process it was recorded for.
 */
export async function processIdentity(pid: number): Promise<{ started: string; comm: string } | null> {
  const run = async (field: string) => {
    const out = await new Deno.Command('/bin/ps', { args: ['-o', `${field}=`, '-p', String(pid)], stdout: 'piped', stderr: 'null' }).output()
    return out.success ? new TextDecoder().decode(out.stdout).trim() : ''
  }
  const [started, comm] = await Promise.all([run('lstart'), run('comm')])
  return started && comm ? { started, comm } : null
}

/** `claude --version`, checked against the pinned version before anything is launched. */
export async function claudeVersion(binary: string, env: Record<string, string>): Promise<string> {
  const out = await new Deno.Command(binary, { args: ['--version'], env, clearEnv: true, stdout: 'piped', stderr: 'piped' }).output()
  const text = new TextDecoder().decode(out.stdout).trim()
  const m = /^(\d+\.\d+\.\d+)/.exec(text)
  if (!out.success || !m) {
    throw new Error(`could not read the Claude Code version from ${binary}: ${text || new TextDecoder().decode(out.stderr).slice(0, 500)}`)
  }
  return m[1]
}

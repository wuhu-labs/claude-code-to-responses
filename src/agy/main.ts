import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { AgyGateway, type Config } from './gateway.ts'
import { runShim } from './shim.ts'

const usage = `Usage: agy-to-responses --state-dir <dir> [--agy <binary>] [--port <port>]
  --agy <binary>           agy executable (default: agy on PATH)
  --port <port>           loopback port (default: 18331; 0 selects a free port)
  --auth-token-env <var>  require the bearer token stored in var
  --allow-untested-agy    allow an agy version other than the checked 1.5.17
  --idle-timeout <sec>    evict an idle process (default: 1800)
  --hold-timeout <sec>    evict a process waiting for tool outputs (default: 600)`

function parse(args: string[]): Config {
  const config: Config = {
    state: '',
    agy: 'agy',
    port: 18331,
    allowUncheckedVersion: false,
    idleMs: 1_800_000,
    holdMs: 600_000,
    helper: [Deno.execPath(), ...(Deno.build.standalone ? [] : ['run', '-A', fileURLToPath(import.meta.url)])],
  }
  const value = (key: string, i: number) => {
    const v = args[i]
    if (!v || v.startsWith('--')) throw new Error(`missing value for ${key}`)
    return v
  }
  function time(v: string) {
    const n = Number(v) * 1000
    if (!(n > 0 && n <= 2_147_483_647)) throw new Error('invalid timeout')
    return n
  }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    switch (arg) {
      case '--agy': {
        const bin = value(arg, ++i)
        config.agy = bin.includes('/') ? resolve(bin) : bin
        break
      }
      case '--state-dir':
        config.state = resolve(value(arg, ++i))
        break
      case '--port':
        config.port = Number(value(arg, ++i))
        break
      case '--auth-token-env': {
        const token = Deno.env.get(value(arg, ++i))
        if (!token) throw new Error('empty bearer-token environment variable')
        config.authToken = token
        break
      }
      case '--allow-untested-agy':
        config.allowUncheckedVersion = true
        break
      case '--idle-timeout':
        config.idleMs = time(value(arg, ++i))
        break
      case '--hold-timeout':
        config.holdMs = time(value(arg, ++i))
        break
      default:
        throw new Error(`unknown option ${arg}`)
    }
  }
  if (!config.state || !Number.isInteger(config.port) || config.port < 0 || config.port > 65535) throw new Error('invalid state directory or port')
  return config
}

if (import.meta.main) {
  try {
    const mode = Deno.args[0]
    if (mode === '--mcp-shim' || mode === '--invocation-hook') await runShim(mode)
    else if (mode === '--help') console.log(usage)
    else {
      const config = parse(Deno.args)
      const gateway = await AgyGateway.start(config)
      const server = gateway.listen(() => {})
      const stop = () => {
        void gateway.close().then(() => server.shutdown()).catch((e) => {
          console.error(e)
          Deno.exit(2)
        })
      }
      Deno.addSignalListener('SIGINT', stop)
      Deno.addSignalListener('SIGTERM', stop)
      console.error(`agy gateway listening on http://${server.addr.hostname}:${server.addr.port}`)
      await server.finished
      Deno.removeSignalListener('SIGINT', stop)
      Deno.removeSignalListener('SIGTERM', stop)
    }
  } catch (e) {
    console.error(`agy gateway: ${e instanceof Error ? e.message : e}`)
    Deno.exit(2)
  }
}

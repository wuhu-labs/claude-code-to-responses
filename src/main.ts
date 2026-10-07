// Entry point: claude-code-to-responses --state-dir … --work-root … --claude …
import { ConfigError, parseArgs, prepare } from './config.ts'
import { Gateway } from './gateway.ts'
import { handler } from './server.ts'

if (import.meta.main) {
  let gw: Gateway
  let config
  try {
    config = prepare(parseArgs(Deno.args, Deno.env.toObject()))
    gw = await Gateway.start(config)
  } catch (e) {
    console.error(e instanceof ConfigError ? e.message : `startup failed: ${e instanceof Error ? e.message : e}`)
    Deno.exit(2)
  }
  const server = Deno.serve({ hostname: config.hostname, port: config.port, onListen: ({ hostname, port }) => console.error(`listening on http://${hostname}:${port}`) }, handler(gw))
  const stop = async () => {
    await gw.close()
    await server.shutdown()
    Deno.exit(0)
  }
  Deno.addSignalListener('SIGINT', stop)
  Deno.addSignalListener('SIGTERM', stop)
}

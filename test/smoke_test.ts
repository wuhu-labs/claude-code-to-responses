import { assert, assertEquals } from '@std/assert'
import { call, FakeAnthropic, text, think } from './fake.ts'
import { cleanup, dirs, Driver, freePort, TestGateway } from './harness.ts'

const TOOLS = [
  { type: 'function', name: 'echo', description: 'Echo the text back.', parameters: { type: 'object', properties: { text: { type: 'string' } } } },
]

Deno.test('smoke: a text turn and a tool round', async () => {
  const fake = new FakeAnthropic(freePort())
  const d = dirs('smoke')
  const tg = await TestGateway.start({ dirs: d, backendEnv: { ANTHROPIC_BASE_URL: fake.url, ANTHROPIC_AUTH_TOKEN: 'fake-key' } })
  try {
    const drv = new Driver(tg.client, { instructions: 'You are a test.', tools: TOOLS, model: 'claude-opus-5-5', mode: 'previous' })
    fake.reply({ blocks: [think('t1'), text('hello')] })
    const r1 = await drv.send([{ role: 'user', content: 'hi' }])
    assertEquals(r1.status, 'completed', JSON.stringify(r1.response.error))
    assertEquals(drv.text(r1), 'hello')
    fake.reply({ blocks: [call('toolu_1', 'echo', { text: 'x' })] }, { blocks: [text('done')] })
    const r2 = await drv.turn('call echo', { echo: (a) => `ECHO ${a.text}` })
    assertEquals(drv.text(r2), 'done')
    assert(r2.response.output.some((o: { type: string; encrypted_content?: string }) => o.type === 'reasoning' && o.encrypted_content?.startsWith('cc2r.record.v1.')))
  } finally {
    await tg.close()
    await fake.close()
    cleanup(d)
  }
  tg.assertClean()
})

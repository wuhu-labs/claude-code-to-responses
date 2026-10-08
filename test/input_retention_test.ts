import { assertEquals } from '@std/assert'
import { parseRequest } from '../src/api/request.ts'
import { ResponseState } from '../src/api/stream.ts'
import { canonItem, digestItems, ItemDigest, sha256 } from '../src/records.ts'

Deno.test('normalized and response echo state do not retain the original input body', () => {
  const req = parseRequest(
    { model: 'test', instructions: 'test', input: 'large input', reasoning: { effort: 'high' }, user: 'test-user', metadata: { a: 'b' } },
    'websocket',
  )
  assertEquals(req.body, { reasoning: { effort: 'high' }, user: 'test-user' })
  const state = new ResponseState(req)
  assertEquals('input' in state.req, false)
  assertEquals([state.object().reasoning.effort, state.object().user, state.object().metadata], ['high', 'test-user', { a: 'b' }])
})

Deno.test('incremental covered-item digest remains byte-compatible with legacy canonical JSON', async () => {
  const input = parseRequest({
    model: 'test',
    instructions: 'test',
    input: [{ role: 'user', content: 'Unicode 🌍 and lone surrogate \ud800' }, { type: 'reasoning', encrypted_content: 'ignored' }],
  }, 'websocket').input
  const outputs = parseRequest({ model: 'test', instructions: 'test', input: [{ role: 'assistant', content: 'done' }] }, 'websocket').input
  const all = [...input, ...outputs]
  const old = await sha256(JSON.stringify(all.map(canonItem).filter((v) => v !== null)))
  assertEquals(await digestItems(all), old)
  assertEquals(new ItemDigest(input).finish(outputs), old)
})

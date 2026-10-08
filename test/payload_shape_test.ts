import { assert } from '@std/assert'
import { encodeRecord, type ProviderRecord } from '../src/records.ts'
Deno.test('offline payload breakdown: text tokens do not bound image and provider-record bytes', async () => {
  let seed = 1
  const noise = (n: number) =>
    Array.from({ length: n }, () => {
      seed ^= seed << 13
      seed ^= seed >>> 17
      seed ^= seed << 5
      return 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'[(seed >>> 0) % 64]
    }).join('')
  const bytes = (x: unknown) => new TextEncoder().encode(JSON.stringify(x)).byteLength
  const text = { role: 'user', content: [{ type: 'input_text', text: 'word '.repeat(240000) }] }
  const record: ProviderRecord = {
    v: 1,
    id: 'resp_' + '1'.repeat(32),
    prev: null,
    chain: '2'.repeat(64),
    instructions: 'offline',
    session: '11111111-1111-1111-1111-111111111111',
    device: '3'.repeat(64),
    end: 'turn',
    calls: [],
    digest: '4'.repeat(64),
    entries: [JSON.stringify({ message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'done', signature: noise(256 * 1024) }] } })],
  }
  const opaque = await encodeRecord(record)
  const reasoning = { type: 'reasoning', summary: [], encrypted_content: opaque }
  const image = { type: 'input_image', detail: 'original', image_url: 'data:image/png;base64,' + 'A'.repeat(4 * Math.ceil((13 * 1024 * 1024) / 3)) }
  for (
    const [name, input] of [['text-only', [text]], ['image', [text, { role: 'user', content: [image] }]], ['records', [
      text,
      ...Array(64).fill(reasoning),
    ]]] as const
  ) {
    const body = { model: 'offline', type: 'response.create', store: false, input }
    assert(bytes(body) < 128 * 1024 * 1024)
    assert(name === 'text-only' ? bytes(body) < 16 * 1024 * 1024 : bytes(body) > 16 * 1024 * 1024)
    console.log(
      JSON.stringify({
        name,
        request_bytes: bytes(body),
        text_item_bytes: bytes(text),
        image_block_bytes: name === 'image' ? bytes(image) : 0,
        reasoning_count: name === 'records' ? 64 : 0,
        reasoning_item_bytes: name === 'records' ? bytes(reasoning) : 0,
        encrypted_content_bytes: opaque.length,
      }),
    )
  }
})

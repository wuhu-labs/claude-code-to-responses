import { rawSocket, readRawFrame, writeAll } from './raw_websocket.ts'

if (import.meta.main) {
  const [url, create, file] = Deno.args
  const conn = await rawSocket(url)
  let added: any, done: any
  try {
    const bytes = new TextEncoder().encode(create)
    if (bytes.length >= 65536) throw new Error('peer fixture create is too large')
    const header = bytes.length < 126 ? [0x81, 0x80 | bytes.length] : [0x81, 0xfe, bytes.length >> 8, bytes.length & 255]
    await writeAll(conn, new Uint8Array([...header, 0, 0, 0, 0, ...bytes]))
    while (true) {
      const frame = await readRawFrame(conn)
      if (frame.opcode === 9) {
        await writeAll(conn, new Uint8Array([0x8a, 0x80 | frame.payload.length, 0, 0, 0, 0, ...frame.payload]))
        continue
      }
      if (frame.opcode !== 1) throw new Error(`unexpected frame ${frame.opcode}: ${new TextDecoder().decode(frame.payload)}`)
      const event = JSON.parse(new TextDecoder().decode(frame.payload))
      if (event.type === 'error') throw new Error(JSON.stringify(event))
      if (event.type === 'response.output_item.added' && event.item.encrypted_content?.startsWith('cc2r.record.v1.')) {
        added = event.item
        Deno.writeTextFileSync(file, added.encrypted_content)
      }
      if (event.type === 'response.output_item.done' && event.item.id === added?.id) done = event.item
      if (event.type === 'response.failed') throw new Error(JSON.stringify(event.response.error))
      if (event.type === 'response.completed') {
        const terminal = event.response.output.at(-1)
        console.log(JSON.stringify({
          id: event.response.id,
          status: event.response.status,
          recordBytes: added.encrypted_content.length,
          addedId: added.id,
          doneId: done.id,
          terminalId: terminal.id,
          doneOpaque: 'encrypted_content' in done,
          terminalOpaque: 'encrypted_content' in terminal,
        }))
        break
      }
    }
  } finally {
    conn.close()
  }
}

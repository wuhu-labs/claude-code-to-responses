import { assert } from '@std/assert'
export async function rawSocket(url: string, token?: string): Promise<Deno.TcpConn> {
  const u = new URL(url)
  const conn = await Deno.connect({ hostname: u.hostname, port: Number(u.port) })
  const request =
    `GET /v1/responses HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n${
      token ? `Authorization: Bearer ${token}\r\n` : ''
    }\r\n`
  await writeAll(conn, new TextEncoder().encode(request))
  let header = ''
  const buf = new Uint8Array(4096)
  while (!header.includes('\r\n\r\n')) {
    const n = await conn.read(buf)
    if (n === null) throw new Error('upgrade EOF')
    header += new TextDecoder().decode(buf.subarray(0, n))
  }
  assert(header.startsWith('HTTP/1.1 101'), header)
  return conn
}
export async function writeAll(conn: Deno.TcpConn, bytes: Uint8Array): Promise<void> {
  let at = 0
  while (at < bytes.length) at += await conn.write(bytes.subarray(at))
}
export async function readRawFrame(conn: Deno.TcpConn): Promise<{ opcode: number; payload: Uint8Array }> {
  const read = async (count: number) => {
    const bytes = new Uint8Array(count)
    let at = 0
    while (at < count) {
      const n = await conn.read(bytes.subarray(at))
      if (n === null) throw new Error('frame EOF')
      at += n
    }
    return bytes
  }
  const header = await read(2)
  let length = header[1] & 127
  if (length === 126) length = new DataView((await read(2)).buffer).getUint16(0)
  if (length === 127) length = Number(new DataView((await read(8)).buffer).getBigUint64(0))
  return { opcode: header[0] & 15, payload: await read(length) }
}

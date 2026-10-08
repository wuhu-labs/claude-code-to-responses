// A finite per-response driver on a persistent real WebSocket. No HTTP fallback.
import type { Json } from './fake.ts'
import type { Result } from './harness.ts'

export class WsClient {
  private queue: Json[] = []
  private waiters: { resolve: (ev: Json) => void; reject: (err: Error) => void }[] = []
  private ended = false
  readonly opened: Promise<void>
  readonly closed: Promise<void>

  constructor(readonly socket: WebSocket) {
    this.opened = new Promise((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true })
      socket.addEventListener('error', () => reject(new Error('WebSocket upgrade failed')), { once: true })
    })
    this.closed = new Promise((resolve) => socket.addEventListener('close', () => resolve(), { once: true }))
    socket.addEventListener('message', (e) => {
      const ev = JSON.parse(e.data)
      const waiter = this.waiters.shift()
      if (waiter) waiter.resolve(ev)
      else this.queue.push(ev)
    })
    socket.addEventListener('close', () => {
      this.ended = true
      for (const w of this.waiters.splice(0)) w.reject(new Error('WebSocket closed before event'))
    })
  }

  next(): Promise<Json> {
    if (this.queue.length) return Promise.resolve(this.queue.shift())
    if (this.ended) return Promise.reject(new Error('WebSocket closed before event'))
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }))
  }

  async send(body: Json): Promise<Result> {
    await this.opened
    this.socket.send(JSON.stringify({ type: 'response.create', ...body }))
    const events: Json[] = []
    while (true) {
      const event = await this.next()
      if (event.type === 'error') throw Object.assign(new Error(event.error.message), { status: event.status, ...event.error, error: event.error })
      events.push(event)
      if (['response.completed', 'response.failed', 'response.incomplete'].includes(event.type)) {
        const added = new Map(events.filter((e) => e.type === 'response.output_item.added').map((e) => [e.item.id, e.item]))
        const response = { ...event.response, output: event.response.output?.map((item: Json) => ({ ...added.get(item.id), ...item })) }
        return { events, response, status: response.status }
      }
    }
  }

  async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) this.socket.close()
    await this.closed
  }
}

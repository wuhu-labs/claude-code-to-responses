// One chain, one process, one response: the lane registry, the reservation that makes a second request on a chain in
// progress `409 conversation_busy`, and the wait for a predecessor's tail before a rebuild. Both lanes use it.
import { GatewayError } from './errors.ts'

export interface ChainLane {
  /** The chain this lane serves: a Claude Code session id, an agy chain id. */
  readonly laneId: string
  /** Stops serving (its process is being killed); a dead lane is not reused. */
  readonly dead: boolean
  /** A response is attached and not yet committed or failed. */
  readonly busy: boolean
  /** Settles once the process is gone and its tail is stored. */
  readonly gone: Promise<void>
  kill(reason: string): Promise<void>
}

export interface Reservation {
  chain: string | null
}

export class Chains<L extends ChainLane> {
  private readonly live = new Map<string, L>()
  private readonly reserved = new Set<string>()
  private readonly dying = new Map<string, Promise<void>>()

  /** Every lane whose process may still be running, live or dying. */
  get lanes(): ReadonlyMap<string, L> {
    return this.live
  }

  get(chain: string): L | undefined {
    return this.live.get(chain)
  }

  add(lane: L): void {
    this.live.set(lane.laneId, lane)
  }

  /** The lane stopped serving requests; its process is on its way out. */
  dead(lane: L): void {
    if (this.live.get(lane.laneId) === lane) this.live.delete(lane.laneId)
    this.dying.set(lane.laneId, lane.gone)
  }

  /** Takes the chain synchronously: `409 conversation_busy` while a response is streaming or another request holds it. */
  reserve(chain: string, reservation: Reservation): void {
    if (this.reserved.has(chain) || this.live.get(chain)?.busy) {
      throw new GatewayError(409, 'conflict_error', 'conversation_busy', 'Another response of this conversation is in progress.')
    }
    this.reserved.add(chain)
    reservation.chain = chain
  }

  release(reservation: Reservation): void {
    if (reservation.chain) this.reserved.delete(reservation.chain)
    reservation.chain = null
  }

  /** Waits for a killing lane of this chain to store its tail. */
  async settled(chain: string): Promise<void> {
    const dying = this.dying.get(chain)
    if (dying) await dying
  }

  /** Stops the chain's live process, if any, and waits until it is gone. */
  async evict(chain: string, reason: string): Promise<void> {
    const lane = this.live.get(chain)
    if (lane) await lane.kill(reason)
    await this.settled(chain)
  }
}

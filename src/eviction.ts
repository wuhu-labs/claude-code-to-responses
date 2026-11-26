// Killing a process that outlived its usefulness: after a finished turn (idle) or while it holds tool calls.
// Both lanes use it; a lane decides when it is at rest and what its process is.
export class Eviction {
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(readonly idleMs: number, readonly holdMs: number) {}

  /** Replaces any pending eviction: a process holding calls waits `holdMs`, an idle one `idleMs`. */
  arm(hold: boolean, evict: () => void): void {
    this.clear()
    this.timer = setTimeout(() => {
      this.timer = undefined
      evict()
    }, hold ? this.holdMs : this.idleMs)
  }

  clear(): void {
    clearTimeout(this.timer)
    this.timer = undefined
  }
}

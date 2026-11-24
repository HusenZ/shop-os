/**
 * Hybrid logical clock. Encoded as "<wall 15 digits>-<counter 4 digits>-<node>"
 * so that lexical order equals HLC order. Survives devices with a wrong clock.
 */
export interface Hlc {
  wall: number;
  counter: number;
  node: string;
}

const MAX_COUNTER = 9999;

export function encodeHlc(h: Hlc): string {
  return `${String(h.wall).padStart(15, '0')}-${String(h.counter).padStart(4, '0')}-${h.node}`;
}

export function decodeHlc(s: string): Hlc {
  const [wall, counter, ...node] = s.split('-');
  return { wall: Number(wall), counter: Number(counter), node: node.join('-') };
}

export class HlcClock {
  private wall = 0;
  private counter = 0;

  constructor(
    readonly node: string,
    last?: string | null,
    private readonly now: () => number = () => Date.now(),
  ) {
    if (last) {
      const h = decodeHlc(last);
      this.wall = h.wall;
      this.counter = h.counter;
    }
  }

  /** A new timestamp for a local event. */
  tick(): string {
    const pt = this.now();
    if (pt > this.wall) {
      this.wall = pt;
      this.counter = 0;
    } else {
      this.counter++;
    }
    this.overflow();
    return encodeHlc({ wall: this.wall, counter: this.counter, node: this.node });
  }

  /** Merge a timestamp received from another device. */
  receive(remote: string): void {
    const r = decodeHlc(remote);
    const pt = this.now();
    const wall = Math.max(this.wall, r.wall, pt);
    if (wall === this.wall && wall === r.wall) this.counter = Math.max(this.counter, r.counter) + 1;
    else if (wall === this.wall) this.counter++;
    else if (wall === r.wall) this.counter = r.counter + 1;
    else this.counter = 0;
    this.wall = wall;
    this.overflow();
  }

  private overflow() {
    if (this.counter > MAX_COUNTER) {
      this.wall++;
      this.counter = 0;
    }
  }

  /** Milliseconds a remote clock is ahead of ours (used to flag skewed devices). */
  skewMs(remote: string): number {
    return decodeHlc(remote).wall - this.now();
  }
}

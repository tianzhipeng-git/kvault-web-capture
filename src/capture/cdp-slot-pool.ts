interface SlotWaiter {
  resolve: (slot: number) => void;
}

interface SlotPoolState {
  available: number[];
  waiters: SlotWaiter[];
}

export interface SlotLease {
  slot: number;
  release(): void;
}

export class CdpSlotPool {
  private readonly pools = new Map<string, SlotPoolState>();

  async acquire(key: string, size: number): Promise<SlotLease> {
    const state = this.getOrCreate(key, size);
    const slot = state.available.shift() ?? await new Promise<number>((resolve) => {
      state.waiters.push({ resolve });
    });
    let released = false;

    return {
      slot,
      release: () => {
        if (released) {
          return;
        }
        released = true;
        const waiter = state.waiters.shift();
        if (waiter) {
          waiter.resolve(slot);
          return;
        }
        state.available.push(slot);
      },
    };
  }

  private getOrCreate(key: string, size: number): SlotPoolState {
    const existing = this.pools.get(key);
    if (existing) {
      return existing;
    }

    const state: SlotPoolState = {
      available: Array.from({ length: size }, (_, index) => index),
      waiters: [],
    };
    this.pools.set(key, state);
    return state;
  }
}

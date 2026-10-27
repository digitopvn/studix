/** Injectable time source so services and tests agree on "now". */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

export interface ManualClock extends Clock {
  set(time: Date | number): void;
  advance(ms: number): void;
}

/** Deterministic clock for tests and replays; time only moves when told to. */
export function createManualClock(start: Date | number = 0): ManualClock {
  let current = typeof start === "number" ? start : start.getTime();
  return {
    now: () => new Date(current),
    set: (time) => {
      current = typeof time === "number" ? time : time.getTime();
    },
    advance: (ms) => {
      current += ms;
    },
  };
}

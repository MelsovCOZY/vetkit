// Retry delay before attempt n+1 (n = 0 for the first retry): 100 ms x 2^n, scaled by a
// jitter factor in [0.5, 1.5) so concurrent drains do not retry in lockstep.
export function backoffDelay(n: number, random: () => number): number {
  return 100 * 2 ** n * (0.5 + random());
}

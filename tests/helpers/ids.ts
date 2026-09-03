let counter = 0

/**
 * Deterministic, monotonic id generator for fixtures. Ids only need to be unique
 * and stable within a run, so a per-file reset is unnecessary; the counter replaces
 * the old `Math.random()` ids that could never be asserted on anyway.
 */
export function nextId(prefix = 'mem'): string {
  return `${prefix}_${(++counter).toString(36)}`
}

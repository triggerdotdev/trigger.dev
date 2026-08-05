/**
 * Queue thresholds shared by more than one surface, kept here so the copies can't drift.
 */

/**
 * Head-of-line wait at which a queue reads as stuck rather than busy. The queue page tints its
 * oldest-wait block at this value, and the watch card recommends an age SLA at the same one.
 */
export const OLDEST_WAIT_WARNING_MS = 5 * 60_000;

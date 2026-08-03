/**
 * The queue thresholds more than one surface has to agree on.
 *
 * Kept in a tiny pure module rather than in the queue detail route: the route
 * tints its **Oldest wait** block at this number, and the watch card recommends an
 * age-SLA watch at the same one. Two copies of "5 minutes" would drift, and then
 * the page would call a queue late while the card offered an SLA it considers fine.
 */

/**
 * Head-of-line wait at which a queue reads as stuck rather than merely busy: the
 * oldest run sitting unstarted this long is the queue page's warning signal.
 */
export const OLDEST_WAIT_WARNING_MS = 5 * 60_000;

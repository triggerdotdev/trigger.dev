/**
 * Bounds the bind-parameter count of a Prisma `in` / `notIn` list filter.
 *
 * Prisma expands a list filter into one bind parameter per element, so every distinct list
 * length is a separate prepared statement. Where the length tracks data volume (a batch
 * size, a run-graph fan-out, a prior query's id set) one call site can mint hundreds of
 * statements. Those entries are used once, but inserting them evicts entries that were
 * being reused, so the cost lands on unrelated queries competing for the same pooler cache.
 *
 * Padding to the next power of two caps a call site at roughly log2(cap) statements instead
 * of one per length. `IN` and `NOT IN` ignore duplicates, so repeating the last element
 * leaves results unchanged.
 *
 * Call it at the filter itself, never on a whole args object:
 *
 *   where: { id: { in: boundedIn(ids) } }
 *
 * Applying this by walking Prisma's args generically is not equivalent and is not safe: a
 * key named `in` inside `data`, or inside a JSON `equals` value, is user data rather than a
 * predicate, and padding it corrupts what gets stored or compared.
 */

/**
 * Postgres accepts at most 65535 bind parameters in one statement. Padding past half of
 * that risks turning a working query into a protocol error, so lists above the cap are
 * returned unchanged; a site that can reach this size wants chunking, not padding.
 */
const MAX_PADDED_LENGTH = 32768;

/**
 * Pads `values` up to the next power of two by repeating the last element.
 *
 * Returns the input array unchanged when it is empty, has a single element, is already a
 * power of two, or exceeds the cap, so the common path allocates nothing.
 *
 * Pads by repeating rather than with null deliberately: `x NOT IN (a, b, NULL)` is never
 * true, so null-padding a `notIn` filter would silently match no rows.
 */
export function boundedIn<T>(values: T[]): T[] {
  const { length } = values;

  if (length < 2 || length > MAX_PADDED_LENGTH) {
    return values;
  }

  let target = 1;
  while (target < length) {
    target *= 2;
  }

  if (target === length || target > MAX_PADDED_LENGTH) {
    return values;
  }

  const padded = values.slice();
  const last = values[length - 1]!;
  while (padded.length < target) {
    padded.push(last);
  }

  return padded;
}

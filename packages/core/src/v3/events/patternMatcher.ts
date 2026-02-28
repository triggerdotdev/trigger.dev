/**
 * Wildcard pattern matching for event slugs.
 *
 * Patterns use dot-separated segments with two wildcards:
 * - `*` matches exactly one segment  (e.g., `order.*` matches `order.created` but not `order.status.changed`)
 * - `#` matches zero or more segments (e.g., `order.#` matches `order.created` and `order.status.changed`)
 *
 * Examples:
 * - `order.*`     → matches `order.created`, `order.updated`
 * - `order.#`     → matches `order.created`, `order.status.changed`, `order`
 * - `*.created`   → matches `order.created`, `user.created`
 * - `#.created`   → matches `order.created`, `org.user.created`, `created`
 */

type PatternPredicate = (eventSlug: string) => boolean;

const patternCache = new Map<string, PatternPredicate>();

/**
 * Compile a wildcard pattern into a reusable predicate.
 * Results are cached by the pattern string.
 */
export function compilePattern(pattern: string): PatternPredicate {
  const cached = patternCache.get(pattern);
  if (cached) return cached;

  const fn = buildPatternFn(pattern);
  patternCache.set(pattern, fn);
  return fn;
}

/**
 * Test whether an event slug matches a wildcard pattern (one-shot, no caching).
 */
export function matchesPattern(eventSlug: string, pattern: string): boolean {
  return compilePattern(pattern)(eventSlug);
}

/**
 * Clear the pattern cache.
 */
export function clearPatternCache(): void {
  patternCache.clear();
}

// ─── Internal ────────────────────────────────────────────────────────

function buildPatternFn(pattern: string): PatternPredicate {
  const patternSegments = pattern.split(".");

  // Fast path: no wildcards — exact match
  if (!patternSegments.includes("*") && !patternSegments.includes("#")) {
    return (slug) => slug === pattern;
  }

  // Use dynamic programming to match patterns with # (multi-segment wildcard)
  return (slug) => {
    const slugSegments = slug.split(".");
    return matchSegments(patternSegments, slugSegments, 0, 0);
  };
}

/**
 * Recursive segment matching with memoization via early returns.
 *
 * patternIdx and slugIdx track position in their respective arrays.
 */
function matchSegments(
  pattern: string[],
  slug: string[],
  patternIdx: number,
  slugIdx: number
): boolean {
  // Both exhausted — match
  if (patternIdx === pattern.length && slugIdx === slug.length) {
    return true;
  }

  // Pattern exhausted but slug has more — no match
  if (patternIdx === pattern.length) {
    return false;
  }

  const segment = pattern[patternIdx]!;

  if (segment === "#") {
    // # matches zero or more segments
    // Try matching 0, 1, 2, ... segments from slug
    for (let skip = 0; skip <= slug.length - slugIdx; skip++) {
      if (matchSegments(pattern, slug, patternIdx + 1, slugIdx + skip)) {
        return true;
      }
    }
    return false;
  }

  // Slug exhausted but pattern has more non-# segments — no match
  if (slugIdx === slug.length) {
    return false;
  }

  if (segment === "*") {
    // * matches exactly one segment
    return matchSegments(pattern, slug, patternIdx + 1, slugIdx + 1);
  }

  // Literal segment — must match exactly
  if (segment === slug[slugIdx]) {
    return matchSegments(pattern, slug, patternIdx + 1, slugIdx + 1);
  }

  return false;
}

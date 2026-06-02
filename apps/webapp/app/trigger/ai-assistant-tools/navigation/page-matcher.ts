import type { PageEntry } from "./page-registry";
import { PAGE_REGISTRY } from "./page-registry";

/**
 * Score a page entry against a search query. Higher = better match.
 * Uses keyword overlap and substring matching — intentionally simple.
 */
function scoreMatch(entry: PageEntry, query: string): number {
  const lower = query.toLowerCase();
  let score = 0;

  // Exact ID match
  if (lower === entry.id) return 100;

  // ID substring
  if (lower.includes(entry.id) || entry.id.includes(lower)) score += 10;

  // Keyword matches
  for (const keyword of entry.keywords) {
    if (lower.includes(keyword)) score += 5;
    if (keyword.includes(lower)) score += 3;
  }

  // Description substring
  if (entry.description.toLowerCase().includes(lower)) score += 2;

  return score;
}

/** Find the best matching page for a destination string */
export function findBestMatch(query: string): PageEntry | null {
  let best: PageEntry | null = null;
  let bestScore = 0;

  for (const entry of PAGE_REGISTRY) {
    const score = scoreMatch(entry, query);
    if (score > bestScore) {
      bestScore = score;
      best = entry;
    }
  }

  return bestScore > 0 ? best : null;
}

/** Find top N matching pages for a search query */
export function findMatches(query: string, limit = 5): PageEntry[] {
  return PAGE_REGISTRY.map((entry) => ({ entry, score: scoreMatch(entry, query) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ entry }) => entry);
}
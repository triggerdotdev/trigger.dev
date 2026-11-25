// Docs search ranking: BM25F over page fields, one result per page with its best section.
// The index is built at build time by scripts/build-search-index.mjs, which loads this file with
// Node's type stripping, so it imports nothing.

export const FIELDS = ["title", "slug", "headings", "description", "body", "code"] as const;
type Field = (typeof FIELDS)[number];

export type Section = { id?: string; heading?: string; text: string };

type IndexedPage = {
  url: string;
  title: string;
  description?: string;
  tag?: string;
  /** listed in the sidebar (in docs.json and not hidden) */
  inNav: boolean;
  /** "api" for API reference pages, "example" for example projects and guides */
  kind?: "api" | "example";
  /** term frequencies per field */
  tf: Record<Field, Record<string, number>>;
  len: Record<Field, number>;
  sections: Section[];
};

export type SearchIndex = { pages: IndexedPage[]; avgLen: Record<Field, number> };

const STOPWORDS = new Set(
  "a an and are as at be by can could do does for from get how i if in into is it its me my of on or our should so that the their them then there this to via was we what when where which who why will with would you your".split(
    " "
  )
);

/** A light suffix stripper: plurals, -ing, -ed and a final e, so retries/retrying/retry and queue/queued meet. */
function stem(word: string): string {
  let w = word;
  if (w.length <= 3 || /\d/.test(w)) return w;
  if (w.endsWith("ies") && w.length > 4) w = w.slice(0, -3) + "y";
  else if (w.endsWith("ied") && w.length > 4) w = w.slice(0, -3) + "y";
  else if (w.endsWith("sses")) w = w.slice(0, -2);
  else if (w.endsWith("s") && !/(ss|us|is)$/.test(w)) w = w.slice(0, -1);
  if (w.length > 5 && w.endsWith("ing")) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith("ed")) w = w.slice(0, -2);
  if (/([b-df-hj-km-np-rtv-z])\1$/.test(w) && w.length > 3) w = w.slice(0, -1);
  if (w.length > 4 && w.endsWith("e")) w = w.slice(0, -1);
  return w;
}

/** Words to terms: lowercase, stopwords out, camelCase identifiers also split into their parts. */
function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.match(/[A-Za-z0-9]+/g) ?? []) {
    const lower = raw.toLowerCase();
    if (!STOPWORDS.has(lower)) out.push(stem(lower));
    const parts = raw.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+|\d+/g);
    if (parts && parts.length > 1)
      for (const p of parts) {
        const l = p.toLowerCase();
        if (!STOPWORDS.has(l)) out.push(stem(l));
      }
  }
  return out;
}

// The index comes back from JSON with a prototype again, so only own keys count.
const count = (tf: Record<string, number>, term: string) =>
  Object.hasOwn(tf, term) ? tf[term] : 0;

export function termFrequencies(text: string): [Record<string, number>, number] {
  // No prototype: a term like "constructor" must not hit Object.prototype.
  const tf: Record<string, number> = Object.create(null);
  const terms = tokenize(text);
  for (const t of terms) tf[t] = (tf[t] ?? 0) + 1;
  return [tf, terms.length];
}

const WEIGHT: Record<Field, number> = {
  title: 6,
  slug: 4,
  headings: 2,
  description: 2,
  body: 1,
  code: 0.5,
};
// Length normalization per field: short fields barely, long ones fully.
const B: Record<Field, number> = {
  title: 0.3,
  slug: 0.3,
  headings: 0.5,
  description: 0.5,
  body: 0.75,
  code: 0.75,
};
const K1 = 1.2;

const normalize = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

export type Hit = { page: IndexedPage; score: number; sections: Section[] };

/** A query's distinct terms, bounded: every term scans every page, and search is public. */
export function queryTerms(query: string): string[] {
  return [...new Set(tokenize(query.slice(0, 200)))].slice(0, 12);
}

export class Searcher {
  private df = new Map<string, number>();
  private index: SearchIndex;
  private headingTerms = new Map<IndexedPage, string[]>();

  constructor(index: SearchIndex) {
    this.index = index;
    for (const page of index.pages) {
      this.headingTerms.set(
        page,
        page.sections.flatMap((s) => (s.heading ? [` ${tokenize(s.heading).join(" ")} `] : []))
      );
      const seen = new Set<string>();
      for (const f of FIELDS) for (const t of Object.keys(page.tf[f])) seen.add(t);
      for (const t of seen) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    }
  }

  private idf(term: string) {
    const n = this.index.pages.length;
    const df = this.df.get(term) ?? 0;
    return Math.log(1 + (n - df + 0.5) / (df + 0.5));
  }

  search(query: string, { limit = 10, tag }: { limit?: number; tag?: string } = {}): Hit[] {
    const terms = queryTerms(query);
    if (!terms.length) return [];
    const q = normalize(query);
    const wantsApi = terms.some((t) => t === "api" || t === "endpoint" || t === "rest");
    const hits: Hit[] = [];
    for (const page of this.index.pages) {
      if (tag && page.tag !== tag) continue;
      let score = 0;
      let matched = 0;
      let named = 0; // query terms found in the title or slug
      for (const t of terms) {
        let wtf = 0;
        for (const f of FIELDS) {
          const tf = count(page.tf[f], t);
          if (!tf) continue;
          const norm = 1 - B[f] + (B[f] * page.len[f]) / (this.index.avgLen[f] || 1);
          wtf += (WEIGHT[f] * tf) / norm;
        }
        if (!wtf) continue;
        matched++;
        if (count(page.tf.title, t) || count(page.tf.slug, t)) named++;
        score += (this.idf(t) * wtf) / (K1 + wtf);
      }
      if (!matched) continue;
      // Pages that match every query term, and pages named by the query, come first.
      score *= (matched / terms.length) ** 2;
      score *= 1 + named / terms.length;
      if (normalize(page.title) === q) score *= 1.5;
      else if (terms.length > 1 && this.headingHasPhrase(page, terms)) score *= 1.3;
      if (!page.inNav) score *= 0.6;
      // Conceptual pages before reference and examples, unless the query asks for the API.
      if (page.kind === "api" && !wantsApi) score *= 0.7;
      if (page.kind === "example") score *= 0.8;
      hits.push({ page, score, sections: [] });
    }
    hits.sort((a, b) => b.score - a.score);
    const top = hits.slice(0, limit);
    for (const hit of top) hit.sections = this.bestSections(hit.page, terms);
    return top;
  }

  /** A heading contains all the query terms, in order and next to each other. */
  private headingHasPhrase(page: IndexedPage, terms: string[]) {
    const phrase = ` ${terms.join(" ")} `;
    return this.headingTerms.get(page)!.some((h) => h.includes(phrase));
  }

  /** Sections ranked by the idf of the query terms they contain, headings counting double. */
  private bestSections(page: IndexedPage, terms: string[]): Section[] {
    const scored = page.sections.map((s, i) => {
      const head = new Set(tokenize(s.heading ?? ""));
      const body = new Set(tokenize(s.text));
      let score = 0;
      for (const t of terms) score += this.idf(t) * ((head.has(t) ? 2 : 0) + (body.has(t) ? 1 : 0));
      return { s, i, score };
    });
    return scored
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || a.i - b.i)
      .map((x) => x.s);
  }
}

/** A readable excerpt of `text`, starting near the first query term. */
export function excerpt(text: string, query: string, max = 220): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const terms = new Set(tokenize(query));
  let start = 0;
  for (const m of flat.matchAll(/[A-Za-z0-9]+/g)) {
    if (terms.has(stem(m[0].toLowerCase()))) {
      start = m.index;
      break;
    }
  }
  if (start < max / 2) start = 0;
  else start = flat.lastIndexOf(" ", start - 40) + 1;
  const end = flat.lastIndexOf(" ", start + max);
  return (start ? "…" : "") + flat.slice(start, end > start ? end : start + max) + "…";
}

/**
 * Where to highlight `query` in `text`: whole words that share a term with the query, by the same
 * tokenizing, stopwords and stemming as ranking. "customize" marks "customizing"; "the", "how"
 * and single letters mark nothing.
 */
export function highlightRanges(text: string, query: string): [start: number, end: number][] {
  const terms = new Set(tokenize(query).filter((t) => t.length > 1));
  if (!terms.size) return [];
  const out: [number, number][] = [];
  for (const m of text.matchAll(/[A-Za-z0-9]+/g))
    if (tokenize(m[0]).some((t) => terms.has(t))) out.push([m.index, m.index + m[0].length]);
  return out;
}

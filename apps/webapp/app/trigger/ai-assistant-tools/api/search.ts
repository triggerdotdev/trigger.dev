/**
 * In-process BM25 search over the API registry. No embeddings, no network —
 * the registry is small (~50 ops) so a hand-rolled BM25 is microseconds.
 */
import registryJson from "./registry.json";

export interface RegistryParam {
  name: string;
  in: "path" | "query" | "body";
  required: boolean;
  type?: string;
  enum?: string[];
  description?: string;
  schema?: unknown;
}

export interface RegistryEntry {
  operationId: string;
  method: string;
  path: string;
  summary: string;
  description?: string;
  tag: string;
  auth: string;
  destructive: boolean;
  parameters: RegistryParam[];
  requiredParams: string[];
  searchText: string;
}

export const registry: RegistryEntry[] = registryJson as RegistryEntry[];

const registryById = new Map(registry.map((e) => [e.operationId, e]));

export function getOperation(operationId: string): RegistryEntry | undefined {
  return registryById.get(operationId);
}

// --- Read vs. approval-gated policy -------------------------------------
//
// The assistant can both read and act, but every state-changing action is
// gated behind explicit user approval in the UI (see `needsApproval` on the
// callApi tool). `isReadOnlyOperation` is the classifier that drives that gate:
// read-only ops run immediately; everything else pauses for a yes/no.
//
// "Read-only" is not simply "GET": `execute_query_v1` (TRQL) is a POST that only
// reads, so it's an explicit allow. Conversely, reading secret *values* (env var
// contents) is treated as approval-gated so the user opts in before a secret is
// surfaced into the LLM context.
const READ_ONLY_POST_OPS = new Set([
  "execute_query_v1",
  "get_query_schema_v1",
  "list_dashboards_v1",
]);

const SECRET_VALUE_READ_OPS = new Set([
  "get_project_envvar_v1",
  "list_project_envvars_v1",
]);

export function isReadOnlyOperation(entry: RegistryEntry): boolean {
  // Personal Access Token ops are uncallable (assistant only holds the env key).
  if (entry.auth === "personalAccessToken") return false;
  // Surfacing a secret value requires the user to opt in.
  if (SECRET_VALUE_READ_OPS.has(entry.operationId)) return false;
  if (entry.destructive) return false;
  return entry.method === "GET" || READ_ONLY_POST_OPS.has(entry.operationId);
}

// --- BM25 ---------------------------------------------------------------

const K1 = 1.5;
const B = 0.75;

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}

interface IndexedDoc {
  entry: RegistryEntry;
  tokens: string[];
  termFreq: Map<string, number>;
  length: number;
}

// Everything the assistant can actually call is searchable, including
// state-changing ops — callApi gates those behind user approval. Only PAT-only
// ops (e.g. the cross-environment `list_project_runs_v1`) are excluded, since
// the assistant holds an env secret key, not a PAT, and could never call them.
const searchableRegistry = registry.filter((e) => e.auth !== "personalAccessToken");

// Built once at module load.
const docs: IndexedDoc[] = searchableRegistry.map((entry) => {
  const tokens = tokenize(entry.searchText);
  const termFreq = new Map<string, number>();
  for (const token of tokens) termFreq.set(token, (termFreq.get(token) ?? 0) + 1);
  return { entry, tokens, termFreq, length: tokens.length };
});

const avgDocLength = docs.reduce((sum, d) => sum + d.length, 0) / (docs.length || 1);

const docFreq = new Map<string, number>();
for (const doc of docs) {
  for (const term of doc.termFreq.keys()) {
    docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
  }
}

function idf(term: string): number {
  const n = docs.length;
  const df = docFreq.get(term) ?? 0;
  // BM25 idf with +1 to stay positive for terms in most docs.
  return Math.log(1 + (n - df + 0.5) / (df + 0.5));
}

export interface SearchResult {
  operationId: string;
  method: string;
  path: string;
  summary: string;
  tag: string;
  destructive: boolean;
}

export function searchApi(query: string, limit = 5): SearchResult[] {
  const queryTerms = [...new Set(tokenize(query))];
  if (queryTerms.length === 0) return [];

  const scored = docs.map((doc) => {
    let score = 0;
    for (const term of queryTerms) {
      const tf = doc.termFreq.get(term);
      if (!tf) continue;
      const numerator = tf * (K1 + 1);
      const denominator = tf + K1 * (1 - B + (B * doc.length) / avgDocLength);
      score += idf(term) * (numerator / denominator);
    }
    return { doc, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ doc }) => ({
      operationId: doc.entry.operationId,
      method: doc.entry.method,
      path: doc.entry.path,
      summary: doc.entry.summary,
      tag: doc.entry.tag,
      destructive: doc.entry.destructive,
    }));
}

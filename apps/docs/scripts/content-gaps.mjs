#!/usr/bin/env node
// Content-gap report: what readers asked Ask AI or searched for in the last 7 days that the docs
// didn't answer, grouped into clusters of similar questions.
//
//   node scripts/content-gaps.mjs                     # PostHog -> markdown report on stdout
//   node scripts/content-gaps.mjs --fixture file.json # same, from a fixture (no keys needed)
//   node scripts/content-gaps.mjs --linear [--min 2]  # also file one Linear issue per new cluster
//
// PostHog: POSTHOG_PERSONAL_API_KEY (query:read), POSTHOG_PROJECT_ID, POSTHOG_HOST (the API
// host, e.g. https://eu.posthog.com). Linear: LINEAR_API_KEY, LINEAR_TEAM_ID, LINEAR_PROJECT_ID.
// Events are the ones the docs site sends (lib/analytics.ts).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { redact } from "../lib/redact.ts";

const DAYS = 7;
const ROW_LIMIT = 100000;

// --- Gaps -------------------------------------------------------------------------------------

/**
 * Searches that didn't help: zero results, or no result clicked. Searches fire once per settled
 * query, so a query that the same session kept typing past (a prefix of its next search within a
 * minute) is an intermediate state, not a search.
 */
export function searchGaps(searches, clicks) {
  const clicked = new Set(clicks.map((c) => `${c.session}\u0000${norm(c.query)}`));
  const bySession = Map.groupBy(searches, (s) => s.session ?? "");
  const gaps = [];
  for (const list of bySession.values()) {
    list.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    list.forEach((s, i) => {
      const next = list[i + 1];
      const q = norm(s.query);
      if (!q) return;
      if (
        next &&
        norm(next.query).startsWith(q) &&
        Date.parse(next.timestamp) - Date.parse(s.timestamp) < 60_000
      )
        return;
      if (Number(s.results) === 0) gaps.push({ kind: "search: no results", text: s.query });
      else if (!clicked.has(`${s.session ?? ""}\u0000${q}`))
        gaps.push({ kind: "search: no click", text: s.query });
    });
  }
  return gaps;
}

/** Ask AI answers that cited nothing, and answers a reader marked unhelpful. */
function askGaps(answers, feedback) {
  const gaps = [];
  for (const a of answers)
    if (!a.aborted && !a.error && a.question && (!a.cited || a.cited.length === 0))
      gaps.push({ kind: "ask: no citations", text: a.question });
  for (const f of feedback)
    if (f.helpful === false && f.question)
      gaps.push({ kind: "ask: thumbs down", text: f.question });
  return gaps;
}

// --- Grouping ---------------------------------------------------------------------------------

const STOP = new Set(
  "a an the and or of to in on for with from by at is are be can do does how i my me we our you your it this that what when where which who why will would should could there their them as if not no use using trigger dev docs".split(
    " "
  )
);
// "retries" -> "retry", "batches" -> "batch", "machines" -> "machine", "class" stays "class".
const stem = (w) =>
  w.replace(/ies$/, "y").replace(/ing$|ed$|(?<=[sxz]|ch|sh)es$|(?<!s)s$/, "") || w;
const keyOf = (terms) =>
  `cg-${createHash("sha256").update(terms.join(" ")).digest("hex").slice(0, 12)}`;
const norm = (text) =>
  String(text ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

/** The words that carry a question's meaning, stemmed and sorted. */
export function terms(text) {
  const words = norm(text)
    .replace(/[^a-z0-9.\s-]/g, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^[.-]+|[.-]+$/g, ""))
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map(stem);
  return [...new Set(words)].sort();
}

const jaccard = (a, b) => {
  const B = new Set(b);
  const inter = a.filter((x) => B.has(x)).length;
  return inter / (a.length + b.length - inter || 1);
};

/**
 * Greedy clusters: the most frequent phrasing seeds a cluster, and any phrasing sharing at least
 * half its terms (Jaccard) joins it. Every phrasing has a key (a hash of its terms), and a cluster
 * carries all of them, so the topic is found in Linear week after week even when another phrasing
 * leads, and issues aren't filed twice.
 */
export function cluster(gaps, threshold = 0.5) {
  const phrasings = new Map();
  for (const g of gaps) {
    const t = terms(g.text);
    if (!t.length) continue;
    const id = t.join(" ");
    const p = phrasings.get(id) ?? { terms: t, count: 0, texts: new Map(), kinds: new Map() };
    p.count += 1;
    p.texts.set(norm(g.text), (p.texts.get(norm(g.text)) ?? 0) + 1);
    p.kinds.set(g.kind, (p.kinds.get(g.kind) ?? 0) + 1);
    phrasings.set(id, p);
  }
  const sorted = [...phrasings.values()].sort(
    (a, b) => b.count - a.count || a.terms.join(" ").localeCompare(b.terms.join(" "))
  );
  const clusters = [];
  for (const p of sorted) {
    const c = clusters.find((c) => jaccard(c.terms, p.terms) >= threshold);
    if (c) {
      c.keys.push(keyOf(p.terms));
      c.count += p.count;
      for (const [k, v] of p.texts) c.texts.set(k, (c.texts.get(k) ?? 0) + v);
      for (const [k, v] of p.kinds) c.kinds.set(k, (c.kinds.get(k) ?? 0) + v);
    } else
      clusters.push({
        ...p,
        keys: [keyOf(p.terms)],
        texts: new Map(p.texts),
        kinds: new Map(p.kinds),
      });
  }
  return clusters.map((c) => {
    const examples = [...c.texts].sort((a, b) => b[1] - a[1]).map(([t]) => t);
    return {
      key: c.keys[0],
      keys: [...c.keys].sort(),
      title: examples[0],
      count: c.count,
      kinds: Object.fromEntries(c.kinds),
      examples: examples.slice(0, 5),
    };
  });
}

// --- Output -----------------------------------------------------------------------------------

const cell = (s) => String(s).replace(/\|/g, "\\|");
const kindsText = (kinds) =>
  Object.entries(kinds)
    .map(([k, n]) => `${k} (${n})`)
    .join(", ");

function report(clusters, { days = DAYS, totals } = {}) {
  const lines = [`# Docs content gaps, last ${days} days`, ""];
  if (totals)
    lines.push(
      `${totals.searches} searches, ${totals.answers} Ask AI answers, ${totals.gaps} that didn't help, in ${clusters.length} groups.`,
      ""
    );
  if (!clusters.length) return [...lines, "Nothing to report."].join("\n");
  lines.push("| # | Readers | Topic | Why | Other phrasings |", "| --- | --- | --- | --- | --- |");
  clusters.forEach((c, i) =>
    lines.push(
      `| ${i + 1} | ${c.count} | ${cell(c.title)} | ${kindsText(c.kinds)} | ${cell(c.examples.slice(1, 4).join("; "))} |`
    )
  );
  return lines.join("\n");
}

export function issueBody(c, days = DAYS) {
  return [
    `Readers asked about this ${c.count} times in the last ${days} days and the docs didn't answer it (${kindsText(c.kinds)}).`,
    "",
    "How they asked (reader text, keys and emails redacted):",
    ...c.examples.map((e) => `- \`${e.replaceAll("`", "'")}\``),
    "",
    "Fix: add or improve the page that should answer this, or make the existing one findable (title, description, search terms).",
    "",
    `content-gap-keys: ${c.keys.join(" ")}`,
  ].join("\n");
}

// --- PostHog ----------------------------------------------------------------------------------

async function hogql(query) {
  const host = (process.env.POSTHOG_HOST ?? "https://eu.posthog.com").replace(/\/$/, "");
  const res = await fetch(`${host}/api/projects/${process.env.POSTHOG_PROJECT_ID}/query/`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.POSTHOG_PERSONAL_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: { kind: "HogQLQuery", query }, name: "docs content gaps" }),
  });
  if (!res.ok) throw new Error(`PostHog query failed: ${res.status} ${await res.text()}`);
  const { columns, results } = await res.json();
  return results.map((row) => Object.fromEntries(columns.map((c, i) => [c, row[i]])));
}

const since = `timestamp > now() - INTERVAL ${DAYS} DAY AND properties.site = 'docs'`;
const parseList = (v) => (Array.isArray(v) ? v : typeof v === "string" && v ? JSON.parse(v) : []);
const parseBool = (v) => v === true || v === "true";

async function fromPostHog() {
  const [searches, clicks, answers, feedback] = await Promise.all([
    hogql(
      `SELECT toString(timestamp) AS timestamp, properties.$session_id AS session, properties.query AS query, properties.results AS results FROM events WHERE event = 'docs_search' AND ${since} LIMIT ${ROW_LIMIT}`
    ),
    hogql(
      `SELECT properties.$session_id AS session, properties.query AS query FROM events WHERE event = 'docs_search_result_clicked' AND ${since} LIMIT ${ROW_LIMIT}`
    ),
    hogql(
      `SELECT properties.question AS question, properties.cited AS cited, properties.aborted AS aborted, properties.error AS error FROM events WHERE event = 'docs_ask_ai_answered' AND ${since} LIMIT ${ROW_LIMIT}`
    ),
    hogql(
      `SELECT properties.question AS question, properties.helpful AS helpful FROM events WHERE event = 'docs_ask_ai_feedback' AND ${since} LIMIT ${ROW_LIMIT}`
    ),
  ]);
  return {
    searches,
    clicks,
    answers: answers.map((a) => ({
      ...a,
      cited: parseList(a.cited),
      aborted: parseBool(a.aborted),
      error: a.error && a.error !== "false" ? a.error : undefined,
    })),
    feedback: feedback.map((f) => ({ ...f, helpful: parseBool(f.helpful) })),
  };
}

// --- Linear -----------------------------------------------------------------------------------

async function linear(query, variables) {
  const res = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: { Authorization: process.env.LINEAR_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (!res.ok || json.errors)
    throw new Error(`Linear: ${JSON.stringify(json.errors ?? res.status)}`);
  return json.data;
}

export async function fileIssues(clusters, min) {
  for (const name of ["LINEAR_API_KEY", "LINEAR_TEAM_ID", "LINEAR_PROJECT_ID"])
    if (!process.env[name]) throw new Error(`--linear needs ${name}`);
  const filed = [];
  for (const c of clusters.filter((c) => c.count >= min)) {
    // Filed already if any of its phrasings' keys is in an issue (older issues carry one key).
    const found = await linear(
      `query($f: IssueFilter!) { issues(first: 1, filter: $f) { nodes { identifier } } }`,
      {
        f: {
          project: { id: { eq: process.env.LINEAR_PROJECT_ID } },
          or: c.keys.map((k) => ({ description: { contains: k } })),
        },
      }
    );
    const existing = found.issues.nodes[0]?.identifier;
    if (existing) {
      filed.push(`${c.key}: already filed as ${existing}`);
      continue;
    }
    const made = await linear(
      `mutation($input: IssueCreateInput!) { issueCreate(input: $input) { issue { identifier url } } }`,
      {
        input: {
          teamId: process.env.LINEAR_TEAM_ID,
          projectId: process.env.LINEAR_PROJECT_ID,
          title: `Docs gap: ${c.title.slice(0, 120)}`,
          description: issueBody(c),
        },
      }
    );
    filed.push(`${c.key}: filed ${made.issueCreate.issue.identifier}`);
  }
  return filed;
}

// --- Main -------------------------------------------------------------------------------------

export function analyse(data) {
  // Events sent before the site redacted free text still carry it as typed.
  const gaps = [
    ...searchGaps(data.searches ?? [], data.clicks ?? []),
    ...askGaps(data.answers ?? [], data.feedback ?? []),
  ].map((g) => ({ ...g, text: redact(g.text) }));
  const clusters = cluster(gaps);
  return {
    clusters,
    totals: {
      searches: (data.searches ?? []).length,
      answers: (data.answers ?? []).length,
      gaps: gaps.length,
    },
  };
}

async function main(argv) {
  const arg = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const fixture = arg("--fixture");
  if (!fixture && !(process.env.POSTHOG_PERSONAL_API_KEY && process.env.POSTHOG_PROJECT_ID)) {
    console.error(
      "Set POSTHOG_PERSONAL_API_KEY and POSTHOG_PROJECT_ID (and POSTHOG_HOST), or pass --fixture <file>."
    );
    process.exit(2);
  }
  const data = fixture ? JSON.parse(readFileSync(fixture, "utf8")) : await fromPostHog();
  // A quiet week still has searches; none at all means the site isn't sending events.
  if (!data.searches.length && !data.answers.length) {
    console.error(`No docs events in ${DAYS} days: check the docs site's analytics key.`);
    process.exit(3);
  }
  const full = Object.entries(data).filter(([, rows]) => rows.length >= ROW_LIMIT);
  if (full.length)
    console.error(`Truncated at ${ROW_LIMIT} rows: ${full.map(([k]) => k).join(", ")}.`);
  const { clusters, totals } = analyse(data);
  console.log(report(clusters, { totals }));
  if (argv.includes("--linear")) {
    const filed = await fileIssues(clusters, Number(arg("--min") ?? 2));
    console.log(["", "## Linear", "", ...filed.map((f) => `- ${f}`)].join("\n"));
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  main(process.argv.slice(2)).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });

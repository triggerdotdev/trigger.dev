#!/usr/bin/env node
// URL contract: every URL the live docs serve today must still resolve on the new site.
// Usage: node scripts/check-urls.mjs <base, e.g. http://localhost:43000/docs> [--refresh] [--live]
// Sources: the live sitemap (a committed snapshot in live-sitemap.txt; --refresh re-fetches it),
// docs.json redirects, and the agent/CLI URLs below. --live adds every page production's sitemap
// lists today: the snapshot is frozen at the switch, so this covers pages first published after it.
// A URL passes when it answers 200, or redirects (max 5 hops) to a page that answers 200 on the same base
// (or, for an external docs.json redirect, to exactly its destination, which is never fetched).
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { contentDirOf } from "../lib/content-files.ts";
import { protectionHeaders } from "./protection-headers.mjs";

const [base] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const docsJsonPath = path.join(contentDirOf(path.resolve(import.meta.dirname, "..")), "docs.json");
if (!base) {
  console.error("usage: node scripts/check-urls.mjs <base> [--refresh] [--live]");
  process.exit(2);
}
const root = base.replace(/\/$/, "");
const LIVE = "https://trigger.dev/docs";
const cache = new URL("./live-sitemap.txt", import.meta.url);

async function liveSitemap() {
  const res = await fetch(`${LIVE}/sitemap.xml`);
  if (!res.ok) throw new Error(`${LIVE}/sitemap.xml: HTTP ${res.status}`);
  const xml = await res.text();
  return [...xml.matchAll(/<loc>https:\/\/trigger\.dev\/docs([^<]*)<\/loc>/g)].map(
    (m) => m[1] || "/"
  );
}

if (process.argv.includes("--refresh") || !existsSync(cache)) {
  writeFileSync(cache, (await liveSitemap()).sort().join("\n") + "\n");
}
const sitemap = readFileSync(cache, "utf8").split("\n").filter(Boolean);
let live = [];
if (process.argv.includes("--live")) {
  try {
    const known = new Set(sitemap);
    live = (await liveSitemap()).filter((p) => !known.has(p));
  } catch (e) {
    // Production being down mustn't block the deploy that fixes it.
    console.log(`urls: warning: ${e.message}; checked the snapshot only`);
  }
}
const redirects = JSON.parse(readFileSync(docsJsonPath, "utf8")).redirects ?? [];

// Used by published CLIs, agents and the dashboard; never drop these.
const contract = [
  "/",
  "/llms.txt",
  "/llms-full.txt",
  "/sitemap.xml",
  "/manual-setup.md", // CLI MCP tools/orgs.ts
  "/tasks/overview.md",
  "/introduction?q=queues", // dashboard ask-AI fallback uses /docs?q=
];

// Wildcard rules (`/v3/:slug*`) are tested with a real page under the destination's prefix.
function expand(r) {
  const m = r.source.match(/^(.*):slug\*$/);
  if (!m) return { path: r.source, want: landing(r.destination) };
  const destPrefix = r.destination.replace(/:slug\*$/, "");
  const sample = sitemap.find(
    (p) => p.startsWith(destPrefix) && p !== destPrefix.replace(/\/$/, "")
  );
  const suffix = sample ? sample.slice(destPrefix.length) : "";
  return { path: m[1] + suffix, want: landing(destPrefix + suffix) };
}

// The site's rules in its order (next.config.mjs): each docs.json rule, then its `.md` twin when
// it's a literal rule to a docs page. Wildcard rules match `.md` paths as they are.
const rules = redirects.flatMap((r) => [
  r,
  ...(r.destination.startsWith("/") && !r.source.includes(":")
    ? [{ source: `${r.source}.md`, destination: `${r.destination}.md` }]
    : []),
]);

// The first rule matching `p`: its destination, or undefined.
function redirectStep(p) {
  for (const r of rules) {
    const m = r.source.match(/^(.*):slug\*$/);
    if (!m) {
      if (r.source === p) return r.destination;
    } else if (p.startsWith(m[1]))
      return r.destination.replace(/:slug\*$/, "") + p.slice(m[1].length);
  }
}

// Where `p` lands after every rule in a chain (`/v3/cli-dev` -> `/cli-dev` -> `/cli-dev-commands`),
// as resolve() follows it.
function landing(p) {
  for (let hop = 0; hop < 5 && p.startsWith("/"); hop++) {
    const next = redirectStep(p);
    if (!next) break;
    p = next;
  }
  return p;
}

// A sitemap URL that docs.json now redirects must land where the redirects say, offsite included.
const redirectTarget = (p) => (redirectStep(p) ? landing(p) : undefined);

const checks = [
  ...sitemap.map((p) => ({ path: p, want: redirectTarget(p), kind: "sitemap" })),
  ...live.map((p) => ({ path: p, want: redirectTarget(p), kind: "live" })),
  ...redirects.map((r) => ({ ...expand(r), kind: "redirect" })),
  // Agents' old `.md` links follow the same rules.
  ...redirects
    .filter((r) => r.destination.startsWith("/") && !r.source.includes(":"))
    .map((r) => ({
      path: `${r.source}.md`,
      want: landing(`${r.source}.md`),
      kind: "redirect",
    })),
  ...contract.map((p) => ({ path: p, kind: "contract" })),
];

async function resolve(path) {
  let url = root + path;
  for (let hop = 0; hop < 5; hop++) {
    // Lets the check through a deployment's Vercel Authentication; refreshed per request because
    // a GitHub OIDC token can expire during a long run.
    const res = await fetch(url, { redirect: "manual", headers: await protectionHeaders() });
    if (res.status >= 300 && res.status < 400) {
      url = new URL(res.headers.get("location"), url).href;
      // Never follow off the base: the bypass secret or OIDC token would go with the request.
      if (new URL(url).origin !== new URL(root).origin) return { status: "offsite", final: url };
      continue;
    }
    return { status: res.status, final: url };
  }
  return { status: "loop", final: url };
}

const failures = [];
const queue = [...checks];
await Promise.all(
  Array.from({ length: 16 }, async () => {
    for (let c; (c = queue.shift());) {
      const r = await resolve(c.path).catch((e) => ({
        status: String(e.cause?.code ?? e),
        final: "",
      }));
      const wrongTarget =
        c.want &&
        r.status === 200 &&
        !r.final.split("?")[0].endsWith(c.want.replace(/\/$/, "") || "/");
      // An external redirect in docs.json passes when it points where docs.json says, unfetched.
      if (r.status === "offsite" && c.want && r.final === c.want) continue;
      if (r.status !== 200 || wrongTarget) failures.push({ ...c, ...r });
    }
  })
);

const by = (k) => checks.filter((c) => c.kind === k).length;
console.log(
  `urls: checked ${checks.length}: ${by("sitemap")} sitemap, ${live.length ? `${by("live")} only in production's sitemap, ` : ""}${by("redirect")} redirects, ${by("contract")} contract`
);
for (const f of failures)
  console.log(
    `FAIL ${f.kind} ${f.path} -> ${f.status} ${f.final}${f.want ? ` (want ${f.want})` : ""}`
  );
console.log(failures.length ? `urls: ${failures.length} failed` : "urls: all passed");
process.exit(failures.length ? 1 : 0);

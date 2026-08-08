import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

type Tier = "first-class" | "sample-only";
type Status = "not-started" | "in-progress" | "complete" | "blocked";

type Provider = {
  id: string;
  label: string;
  tier: Tier;
  preset: string | null;
  sampleSource: string;
  sampleCount: number;
  status: Status;
  owner: string | null;
  checklist: Record<string, boolean>;
  notes: string;
};

type Catalog = {
  release: string;
  updatedAt: string | null;
  definitionOfDone: Record<Tier, string[]>;
  statusValues: Status[];
  providers: Provider[];
};

const catalogPath = fileURLToPath(new URL("./providers.json", import.meta.url));
const catalog: Catalog = JSON.parse(readFileSync(catalogPath, "utf8"));

const dodProgress = (p: Provider) => {
  const keys = catalog.definitionOfDone[p.tier] ?? [];
  const done = keys.filter((k) => p.checklist[k] === true).length;
  return { done, total: keys.length, keys };
};

const derivedComplete = (p: Provider) => {
  const { done, total } = dodProgress(p);
  return total > 0 && done === total;
};

const byStatus = (s: Status) => catalog.providers.filter((p) => p.status === s);

const args = process.argv.slice(2);

if (args.includes("--json")) {
  const summary = {
    release: catalog.release,
    updatedAt: catalog.updatedAt,
    total: catalog.providers.length,
    counts: Object.fromEntries(catalog.statusValues.map((s) => [s, byStatus(s).length])),
    remaining: catalog.providers.filter((p) => p.status !== "complete").length,
    providers: catalog.providers.map((p) => ({
      id: p.id,
      tier: p.tier,
      status: p.status,
      owner: p.owner,
      progress: dodProgress(p),
      derivedComplete: derivedComplete(p),
    })),
  };
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

const nextFlagIdx = args.indexOf("--next");
if (nextFlagIdx !== -1) {
  const n = Number(args[nextFlagIdx + 1] ?? "1") || 1;
  const claimable = catalog.providers
    .filter((p) => p.status === "not-started" && p.owner === null)
    .slice(0, n)
    .map((p) => p.id);
  console.log(claimable.join("\n"));
  process.exit(0);
}

const line = (p: Provider) => {
  const { done, total } = dodProgress(p);
  const owner = p.owner ? ` owner=${p.owner}` : "";
  const drift = p.status === "complete" && !derivedComplete(p) ? "  [!] checklist incomplete" : "";
  const samples = p.sampleCount > 0 ? `${p.sampleCount} samples` : "no samples yet";
  return `    ${p.id.padEnd(12)} [${p.tier.padEnd(11)}] ${done}/${total}  preset=${
    p.preset ?? "none"
  }  ${samples}${owner}${drift}`;
};

const total = catalog.providers.length;
const counts = Object.fromEntries(catalog.statusValues.map((s) => [s, byStatus(s).length]));
const remaining = catalog.providers.filter((p) => p.status !== "complete").length;

console.log(`\nWebhook provider catalog: ${catalog.release}`);
console.log(`Updated: ${catalog.updatedAt ?? "never"}`);
console.log(
  `Total ${total}  |  complete ${counts.complete}  in-progress ${counts["in-progress"]}  not-started ${counts["not-started"]}  blocked ${counts.blocked}`
);
console.log(`Remaining (not complete): ${remaining}\n`);

for (const s of catalog.statusValues) {
  const group = byStatus(s);
  if (group.length === 0) continue;
  console.log(`  ${s} (${group.length}):`);
  for (const p of group) console.log(line(p));
  console.log("");
}

const claimable = catalog.providers.filter((p) => p.status === "not-started" && p.owner === null);
if (claimable.length > 0) {
  console.log(`Next claimable: ${claimable.map((p) => p.id).join(", ")}`);
} else if (remaining === 0) {
  console.log("All providers complete.");
} else {
  console.log("Nothing claimable (remaining work is in-progress or blocked).");
}
console.log("");

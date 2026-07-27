/**
 * Wait until every run in a batch manifest reaches a terminal state (so startedAt
 * is populated), by retrieving each run id (Postgres path; runs.list is unreliable
 * on this instance). Env: TRIGGER_API_URL, TRIGGER_SECRET_KEY.
 * Args (env): BATCH=<id>  OUT=./e2e-results  TIMEOUT_S=420  POLL_CONCURRENCY=20
 */
import { configure, runs } from "@trigger.dev/sdk";
import { readFileSync } from "node:fs";

const TERMINAL = [
  "COMPLETED",
  "FAILED",
  "CRASHED",
  "SYSTEM_FAILURE",
  "CANCELED",
  "TIMED_OUT",
  "EXPIRED",
];

async function statusMap(ids: string[], conc: number): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let i = 0;
  async function w() {
    while (i < ids.length) {
      const id = ids[i++]!;
      try {
        const r = await runs.retrieve(id);
        out.set(id, r.status);
      } catch {
        out.set(id, "ERR_RETRIEVE");
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(conc, ids.length) }, w));
  return out;
}

async function main() {
  configure({
    baseURL: process.env.TRIGGER_API_URL!,
    accessToken: process.env.TRIGGER_SECRET_KEY!,
  });
  const batch = process.env.BATCH!;
  const outDir = process.env.OUT ?? "./e2e-results";
  const timeoutMs = Number(process.env.TIMEOUT_S ?? "420") * 1000;
  const conc = Number(process.env.POLL_CONCURRENCY ?? "20");
  const manifest = JSON.parse(readFileSync(`${outDir}/manifest-${batch}.json`, "utf8"));
  const ids: string[] = manifest.runs.map((r: any) => r.id);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const sm = await statusMap(ids, conc);
    let terminal = 0;
    for (const s of sm.values()) if (TERMINAL.includes(s)) terminal++;
    console.log(`[waitdrain] ${batch}: terminal ${terminal}/${ids.length}`);
    if (terminal >= ids.length) {
      console.log("[waitdrain] drained.");
      return;
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  console.log("[waitdrain] TIMEOUT before full drain.");
  process.exit(2);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});

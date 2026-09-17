// Node 24 strips the helper's types, so the weekly job needs no dependency install.
import { readFileSync, writeFileSync } from "node:fs";
import { updateTestTimings } from "../src/test-timings.ts";

const [reportPath, timingsPath] = process.argv.slice(2);
if (!reportPath || !timingsPath) {
  throw new Error(
    "Usage: update-test-timings.mjs <internal-test-results.json> <test-timings.json>"
  );
}
const previous = JSON.parse(readFileSync(timingsPath, "utf8"));
const report = JSON.parse(readFileSync(reportPath, "utf8"));
const updated = updateTestTimings(previous, report);
writeFileSync(timingsPath, `${JSON.stringify(updated, null, 2)}\n`);
console.log(
  `Refreshed ${Object.keys(updated).filter((file) => updated[file] !== previous[file]).length} timings`
);

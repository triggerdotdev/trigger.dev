import * as fs from "node:fs";
import { getCatalog } from "internal-catalog";

async function run() {
  console.log("Start creating catalog entries...");

  const file = fs.readFileSync("../../apps/webapp/integrations.yml", "utf8");
  const catalog = getCatalog(file);
  console.log(catalog);
}

run();

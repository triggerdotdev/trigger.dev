import * as fs from "node:fs";
import { getCatalog } from "internal-catalog";

export function getIntegrations() {
  const file = fs.readFileSync("./integrations.yml", "utf8");
  return getCatalog(file);
}

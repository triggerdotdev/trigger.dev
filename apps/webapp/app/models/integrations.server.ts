import * as fs from "node:fs";
import { getCatalog } from "internal-providers";

export function getIntegrations(showAdminOnly: boolean) {
  const file = fs.readFileSync("./integrations.yml", "utf8");
  return getCatalog(file, showAdminOnly);
}

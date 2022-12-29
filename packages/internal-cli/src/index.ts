import * as fs from "node:fs";
import { getCatalog } from "internal-catalog";

async function run() {
  const args = process.argv.slice(2);
  const [integrationFilePath] = args;

  if (!integrationFilePath) {
    console.error(
      "Missing integration file path.",
      "You probably want to pass in: ../../apps/webapp/integrations.yml"
    );
    return;
  }

  const file = fs.readFileSync(integrationFilePath, "utf8");
  const catalog = getCatalog(file);
}

run();

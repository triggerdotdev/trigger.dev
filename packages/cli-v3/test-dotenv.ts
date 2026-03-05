import { resolveDotEnvVars } from "./src/utilities/dotEnv.js";
import fs from "node:fs";
import { resolve } from "node:path";

const tempDir = resolve(process.cwd(), "temp-env-test");
if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);

fs.writeFileSync(resolve(tempDir, ".env"), "TEST_VAR=base\nTRIGGER_API_URL=http://base");
fs.writeFileSync(resolve(tempDir, ".env.local"), "TEST_VAR=override");

console.log("Testing with .env and .env.local...");
const vars = resolveDotEnvVars(tempDir);
console.log("Resolved vars:", vars);

if (vars.TEST_VAR === "override") {
    console.log("✅ SUCCESS: .env.local overrides .env");
} else {
    console.log("❌ FAILURE: .env.local did NOT override .env. Got:", vars.TEST_VAR);
    process.exit(1);
}

fs.rmSync(tempDir, { recursive: true, force: true });

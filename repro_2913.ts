
import { installDependencies } from "nypm";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";

const testDir = join(process.cwd(), "repro-2913");

try {
    rmSync(testDir, { recursive: true, force: true });
} catch { }

mkdirSync(testDir);

const packageJson = {
    name: "repro-2913",
    version: "1.0.0",
    engines: {
        node: "22.0.0"
    },
    dependencies: {
        "is-odd": "3.0.1"
    }
};

writeFileSync(join(testDir, "package.json"), JSON.stringify(packageJson, null, 2));

console.log(`Current Node Version: ${process.version}`);
console.log("Installing dependencies with strict engine requirement (Node 22)...");

installDependencies({ cwd: testDir, silent: false })
    .then(() => console.log("Install Success!"))
    .catch((e) => {
        console.error("Install Failed as expected!");
        console.error(e);
    });

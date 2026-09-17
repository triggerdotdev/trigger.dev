import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export function getInternalTestProjects(monorepoRoot: string) {
  return readdirSync(resolve(monorepoRoot, "internal-packages"))
    .sort()
    .flatMap((directory) => {
      const root = resolve(monorepoRoot, "internal-packages", directory);
      const manifestPath = resolve(root, "package.json");
      if (!existsSync(manifestPath)) return [];
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (!manifest.name?.startsWith("@internal/") || !manifest.scripts?.test) return [];
      // Keep custom test commands from being bypassed if a package changes later.
      if (
        !/^vitest(?: run)?(?: --sequence.concurrent=false)?(?: --no-file-parallelism)?$/.test(
          manifest.scripts.test
        )
      ) {
        throw new Error(`Unsupported test command for ${manifest.name}: ${manifest.scripts.test}`);
      }
      return [{ root, name: manifest.name as string }];
    });
}

// Report replay needs the same names and roots to reconstruct Vitest's test IDs.
// Inline projects avoid loading package configs or installing workspace dependencies.
export function getInternalTestReportConfig(monorepoRoot: string) {
  return {
    test: {
      projects: getInternalTestProjects(monorepoRoot).map(({ root, name }) => ({
        extends: false as const,
        configFile: false as const,
        test: { root, name },
      })),
    },
  };
}

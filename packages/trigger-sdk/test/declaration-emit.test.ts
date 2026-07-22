import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";

/**
 * Regression test for declaration-emit portability (customer TS2742).
 *
 * Simulates a real consumer: the BUILT package (dist + package.json) is
 * copied (not symlinked — tsc's module-specifier generation only uses the
 * exports map for files under node_modules real paths) into a temp
 * project's node_modules, then a chat-builder agent export is compiled
 * with `declaration: true`. Every type appearing in the inferred public
 * surface must be nameable through a public package specifier; a type
 * declared in a module that isn't reachable via the exports map produces
 * a relative-path import in the emit and TS2742 for consumers.
 */

const packageRoot = resolve(__dirname, "..");
const distDir = join(packageRoot, "dist");
const coreRoot = resolve(packageRoot, "../core");

const FIXTURE_SOURCE = `
import { chat } from "@trigger.dev/sdk/ai";
import { streamText } from "ai";
import type { UIMessage } from "ai";
import { z } from "zod";

type FixtureUIMessage = UIMessage<never, { kind: { value: string } }>;

export const fixtureAgent = chat
  .withUIMessage<FixtureUIMessage>()
  .withClientData({ schema: z.object({ userId: z.string() }) })
  .agent({
    id: "fixture-agent",
    run: async ({ messages, signal }) => {
      return streamText({ model: "openai/gpt-5" as never, messages, abortSignal: signal });
    },
  });
`;

describe("declaration emit portability", () => {
  it.skipIf(!existsSync(distDir) || !existsSync(join(coreRoot, "dist")))(
    "emits portable declarations for inferred chat agent types",
    () => {
      const consumerDir = mkdtempSync(join(tmpdir(), "sdk-decl-emit-"));
      try {
        const scopedDir = join(consumerDir, "node_modules", "@trigger.dev");
        mkdirSync(scopedDir, { recursive: true });

        for (const [name, root] of [
          ["sdk", packageRoot],
          ["core", coreRoot],
        ] as const) {
          const target = join(scopedDir, name);
          mkdirSync(target, { recursive: true });
          cpSync(join(root, "package.json"), join(target, "package.json"));
          cpSync(join(root, "dist"), join(target, "dist"), { recursive: true });
        }

        // Third-party type deps resolve fine through symlinks.
        for (const dep of ["ai", "zod", "@ai-sdk/provider"]) {
          const source = realpathSync(join(packageRoot, "node_modules", dep));
          const target = join(consumerDir, "node_modules", dep);
          mkdirSync(resolve(target, ".."), { recursive: true });
          symlinkSync(source, target);
        }

        const fixturePath = join(consumerDir, "agent.ts");
        ts.sys.writeFile(fixturePath, FIXTURE_SOURCE);

        const emitted = new Map<string, string>();
        const host = ts.createCompilerHost({});
        host.writeFile = (fileName, text) => emitted.set(fileName, text);

        const program = ts.createProgram({
          rootNames: [fixturePath],
          options: {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.NodeNext,
            moduleResolution: ts.ModuleResolutionKind.NodeNext,
            strict: true,
            declaration: true,
            emitDeclarationOnly: true,
            skipLibCheck: true,
            outDir: join(consumerDir, "out"),
            rootDir: consumerDir,
          },
          host,
        });

        const emitResult = program.emit();
        const diagnostics = [
          ...ts.getPreEmitDiagnostics(program),
          ...emitResult.diagnostics,
        ].filter((d) => d.category === ts.DiagnosticCategory.Error);
        const formatted = diagnostics.map((d) =>
          ts.flattenDiagnosticMessageText(d.messageText, "\n")
        );
        expect(formatted).toEqual([]);

        const dts = [...emitted.entries()].find(([name]) => name.endsWith("agent.d.ts"))?.[1];
        expect(dts).toBeDefined();
        // The payload generic must be named via the public subpath, and the
        // emit must not fall back to file paths into the package.
        expect(dts).toContain('import("@trigger.dev/sdk/chat").ChatTaskWirePayload');
        expect(dts).not.toMatch(/import\("\.{1,2}\//);
        expect(dts).not.toContain("ai-shared");
      } finally {
        rmSync(consumerDir, { recursive: true, force: true });
      }
    }
  );
});

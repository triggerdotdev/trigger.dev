import { build } from "esbuild";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("schema composition compatibility", () => {
  it("parses Zod 4 parent schemas when the root Zod export resolves to Zod 3", async () => {
    const result = await build({
      stdin: {
        contents: `
          import { ScheduleMetadata, WebhookMetadata } from "./src/v3/schemas/schemas.ts";
          import { WebhookResource } from "./src/v3/schemas/resources.ts";

          const verifierArtifact = {
            kind: "preset",
            preset: "stripe",
            config: { scheme: "shared-secret", placement: "header" },
          };
          const routingTarget = { type: "task", taskId: "my-task" };

          export const parsed = {
            schedule: ScheduleMetadata.parse({
              cron: "0 0 * * *",
              timezone: "UTC",
              window: "10%",
            }),
            metadata: WebhookMetadata.parse({
              id: "my-webhook",
              source: "stripe",
              verifierArtifact,
              routingTarget,
            }),
            resource: WebhookResource.parse({
              id: "my-webhook",
              filePath: "src/trigger.ts",
              source: "stripe",
              verifierArtifact,
              routingTarget,
            }),
          };
        `,
        loader: "ts",
        resolveDir: packageRoot,
      },
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node20",
      write: false,
      plugins: [
        {
          name: "resolve-root-zod-to-v3",
          setup(build) {
            build.onResolve({ filter: /^zod$/ }, () => ({ path: require.resolve("zod/v3") }));
          },
        },
      ],
    });

    const bundledModule = await import(
      `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`
    );

    expect(bundledModule.parsed).toMatchObject({
      schedule: { window: "10%" },
      metadata: { id: "my-webhook" },
      resource: { id: "my-webhook" },
    });
  });
});

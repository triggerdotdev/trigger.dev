import { BuildExtension } from "@trigger.dev/core/v3/build";
import { syncEnvVars } from "./core.js";

export function vercelSyncEnvVars(): BuildExtension {
  const sync = syncEnvVars(async (ctx) => {
    const environmentMap = {
      prod: "production",
      staging: "preview",
      dev: "development",
    } as const;

    const vercelEnvironment =
      environmentMap[ctx.environment as keyof typeof environmentMap];

    const vercelApiUrl =
      `https://api.vercel.com/v8/projects/${process.env.VERCEL_PROJECT_ID}/env?decrypt=true`;

    const response = await fetch(vercelApiUrl, {
      headers: {
        Authorization: `Bearer ${process.env.VERCEL_ACCESS_TOKEN}`,
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();

    const filteredEnvs = data.envs
      .filter(
        (env: { type: string; value: string; target: string[] }) =>
          env.type === "encrypted" && env.value &&
          env.target.includes(vercelEnvironment),
      )
      .map((env: { key: string; value: string }) => ({
        name: env.key,
        value: env.value,
      }));

    return filteredEnvs;
  });

  return {
    name: "SyncVercelEnvVarsExtension",
    async onBuildComplete(context, manifest) {
      await sync.onBuildComplete?.(context, manifest);
    },
  };
}

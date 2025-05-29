import { BuildExtension } from "@trigger.dev/core/v3/build";
import { syncEnvVars } from "../core.js";

type EnvVar = { name: string; value: string; isParentEnv?: boolean };

export function syncVercelEnvVars(options?: {
  projectId?: string;
  vercelAccessToken?: string;
  vercelTeamId?: string;
  branch?: string;
}): BuildExtension {
  const sync = syncEnvVars(async (ctx) => {
    const projectId =
      options?.projectId ?? process.env.VERCEL_PROJECT_ID ?? ctx.env.VERCEL_PROJECT_ID;
    const vercelAccessToken =
      options?.vercelAccessToken ??
      process.env.VERCEL_ACCESS_TOKEN ??
      ctx.env.VERCEL_ACCESS_TOKEN ??
      process.env.VERCEL_TOKEN;
    const vercelTeamId =
      options?.vercelTeamId ?? process.env.VERCEL_TEAM_ID ?? ctx.env.VERCEL_TEAM_ID;
    const branch =
      options?.branch ??
      process.env.VERCEL_PREVIEW_BRANCH ??
      ctx.env.VERCEL_PREVIEW_BRANCH ??
      ctx.branch;

    console.debug("syncVercelEnvVars()", {
      projectId,
      vercelTeamId,
      branch,
    });

    if (!projectId) {
      throw new Error(
        "syncVercelEnvVars: you did not pass in a projectId or set the VERCEL_PROJECT_ID env var."
      );
    }

    if (!vercelAccessToken) {
      throw new Error(
        "syncVercelEnvVars: you did not pass in a vercelAccessToken or set the VERCEL_ACCESS_TOKEN env var."
      );
    }

    const environmentMap = {
      prod: "production",
      staging: "preview",
      dev: "development",
      preview: "preview",
    } as const;

    const vercelEnvironment = environmentMap[ctx.environment as keyof typeof environmentMap];

    if (!vercelEnvironment) {
      throw new Error(
        `Invalid environment '${ctx.environment}'. Expected 'prod', 'staging', or 'dev'.`
      );
    }
    const params = new URLSearchParams({ decrypt: "true" });
    if (vercelTeamId) params.set("teamId", vercelTeamId);
    params.set("target", vercelEnvironment);
    const vercelApiUrl = `https://api.vercel.com/v8/projects/${projectId}/env?${params}`;

    try {
      const response = await fetch(vercelApiUrl, {
        headers: {
          Authorization: `Bearer ${vercelAccessToken}`,
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();

      const isBranchable = ctx.environment === "preview";

      const filteredEnvs: EnvVar[] = data.envs
        .filter(
          (env: { type: string; value: string; target: string[] }) =>
            env.value && env.target.includes(vercelEnvironment)
        )
        .map((env: { key: string; value: string; gitBranch?: string }) => {
          return {
            name: env.key,
            value: env.value,
            isParentEnv: isBranchable && !env.gitBranch,
          };
        });

      return filteredEnvs;
    } catch (error) {
      console.error("Error fetching or processing Vercel environment variables:", error);
      throw error; // Re-throw the error to be handled by the caller
    }
  });

  return {
    name: "SyncVercelEnvVarsExtension",
    async onBuildComplete(context, manifest) {
      await sync.onBuildComplete?.(context, manifest);
    },
  };
}

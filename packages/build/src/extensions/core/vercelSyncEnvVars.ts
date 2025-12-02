import { BuildExtension } from "@trigger.dev/core/v3/build";
import { syncEnvVars } from "../core.js";

type EnvVar = { name: string; value: string; isParentEnv?: boolean };

type VercelEnvVar = {
  key: string;
  value: string;
  type: string;
  target: string[];
  gitBranch?: string;
};

// List of Neon DB related environment variables to sync,
// provided by Vercel's NeonDB integration
const NEON_ENV_VARS = [
  "PGUSER",
  "POSTGRES_URL_NO_SSL",
  "POSTGRES_HOST",
  "POSTGRES_URL",
  "POSTGRES_PRISMA_URL",
  "DATABASE_URL_UNPOOLED",
  "POSTGRES_URL_NON_POOLING",
  "PGHOST",
  "POSTGRES_USER",
  "DATABASE_URL",
  "POSTGRES_PASSWORD",
  "POSTGRES_DATABASE",
  "PGPASSWORD",
  "PGDATABASE",
  "PGHOST_UNPOOLED",
];
const VERCEL_NEON_ENV_VAR_PREFIX = "";
const NEON_PROJECT_ID_ENV_VAR = "NEON_PROJECT_ID";

type NeonBranch = {
  id: string;
  name: string;
};

type NeonEndpoint = {
  id: string;
  host: string;
  type: string;
};

async function fetchNeonBranchEnvVars(options: {
  neonProjectId: string;
  neonDbAccessToken: string;
  branch: string;
  vercelEnvironment: string;
  filteredEnvs: EnvVar[];
  vercelNeonEnvVarPrefix: string;
}): Promise<EnvVar[] | null> {
  const {
    neonProjectId,
    neonDbAccessToken,
    branch,
    vercelEnvironment,
    filteredEnvs,
    vercelNeonEnvVarPrefix,
  } = options;

  // Step 1: Search for the branch in Neon
  const branchSearchParams = new URLSearchParams({ search: branch });
  const branchesUrl = `https://console.neon.tech/api/v2/projects/${neonProjectId}/branches?${branchSearchParams}`;

  const branchesResponse = await fetch(branchesUrl, {
    headers: {
      Authorization: `Bearer ${neonDbAccessToken}`,
    },
  });

  if (!branchesResponse.ok) {
    throw new Error(`Failed to fetch Neon branches: ${branchesResponse.status}`);
  }

  const branchesData = await branchesResponse.json();
  const branches: NeonBranch[] = branchesData.branches || [];

  if (branches.length === 0) {
    // No matching branch found, return null to keep original env vars
    return null;
  }

  // Neon branch names are prefixed with Vercel environment (e.g., "preview/branch-name")
  // Filter branches to find the one with the exact matching name
  const expectedBranchName = `${vercelEnvironment}/${branch}`;
  const matchingBranch = branches.find((b) => b.name === expectedBranchName || b.name === branch);

  if (!matchingBranch) {
    // No exact match found, return null to keep original env vars
    return null;
  }

  const neonBranchId = matchingBranch.id;

  // Step 2: Get endpoints for the branch
  const endpointsUrl = `https://console.neon.tech/api/v2/projects/${neonProjectId}/branches/${neonBranchId}/endpoints`;

  const endpointsResponse = await fetch(endpointsUrl, {
    headers: {
      Authorization: `Bearer ${neonDbAccessToken}`,
    },
  });

  if (!endpointsResponse.ok) {
    throw new Error(`Failed to fetch Neon branch endpoints: ${endpointsResponse.status}`);
  }

  const endpointsData = await endpointsResponse.json();
  const endpoints: NeonEndpoint[] = endpointsData.endpoints || [];

  if (endpoints.length === 0) {
    // No endpoints found, return null
    return null;
  }

  // Find an endpoint with type containing 'write', or take the first one
  const writeEndpoint = endpoints.find((ep) => ep.type.includes("write"));
  const endpoint = writeEndpoint || endpoints[0];

  if (!endpoint) {
    return null;
  }

  // Step 3: Build new environment variables based on the endpoint host
  // We need to find DATABASE_URL from filteredEnvs to extract user, password, and database name
  const prefixedDatabaseUrlKey = `${vercelNeonEnvVarPrefix}DATABASE_URL`;
  const databaseUrlEnv = filteredEnvs.find(
    (env) => env.name === prefixedDatabaseUrlKey || env.name === "DATABASE_URL"
  );

  if (!databaseUrlEnv) {
    // No DATABASE_URL found, cannot construct new env vars
    return null;
  }

  // Parse DATABASE_URL to extract components
  // Format: postgresql://user:password@host/database?sslmode=require
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(databaseUrlEnv.value);
  } catch {
    // Invalid URL, return null
    return null;
  }

  const user = parsedUrl.username;
  const password = parsedUrl.password;
  const database = parsedUrl.pathname.slice(1); // Remove leading slash
  const newHost = endpoint.host;
  const poolerHost = newHost.replace(/^([^.]+)\./, "$1-pooler.");

  // Build new env vars
  const newEnvVars: EnvVar[] = [];

  const envVarMappings: Record<string, string> = {
    PGUSER: user,
    PGPASSWORD: password,
    PGDATABASE: database,
    PGHOST: poolerHost,
    PGHOST_UNPOOLED: newHost,
    POSTGRES_USER: user,
    POSTGRES_PASSWORD: password,
    POSTGRES_DATABASE: database,
    POSTGRES_HOST: poolerHost,
    DATABASE_URL: `postgresql://${user}:${password}@${poolerHost}/${database}?sslmode=require`,
    DATABASE_URL_UNPOOLED: `postgresql://${user}:${password}@${newHost}/${database}?sslmode=require`,
    POSTGRES_URL: `postgresql://${user}:${password}@${poolerHost}/${database}?sslmode=require`,
    POSTGRES_URL_NO_SSL: `postgresql://${user}:${password}@${poolerHost}/${database}`,
    POSTGRES_URL_NON_POOLING: `postgresql://${user}:${password}@${newHost}/${database}?sslmode=require`,
    POSTGRES_PRISMA_URL: `postgresql://${user}:${password}@${poolerHost}/${database}?sslmode=require&pgbouncer=true&connect_timeout=15`,
  };

  for (const neonEnvVar of NEON_ENV_VARS) {
    const prefixedKey = `${vercelNeonEnvVarPrefix}${neonEnvVar}`;
    // Only override if the env var exists in filteredEnvs
    const envInFiltered = filteredEnvs.find((env) => env.name === prefixedKey);
    if (envInFiltered && envVarMappings[neonEnvVar]) {
      newEnvVars.push({
        name: prefixedKey,
        value: envVarMappings[neonEnvVar],
        isParentEnv: envInFiltered.isParentEnv,
      });
    }
  }

  return newEnvVars;
}

export function syncVercelEnvVars(options?: {
  projectId?: string;
  vercelAccessToken?: string;
  vercelTeamId?: string;
  branch?: string;
  neonDbAccessToken?: string;
  neonProjectId?: string;
  vercelNeonEnvVarPrefix?: string;
}): BuildExtension {
  const sync = syncEnvVars(async (ctx) => {
    const projectId =
      options?.projectId ?? process.env.VERCEL_PROJECT_ID ?? ctx.env.VERCEL_PROJECT_ID;
    const vercelAccessToken =
      options?.vercelAccessToken ??
      process.env.VERCEL_ACCESS_TOKEN ??
      ctx.env.VERCEL_ACCESS_TOKEN ??
      process.env.VERCEL_TOKEN;
    const neonDbAccessToken =
      options?.neonDbAccessToken ?? process.env.NEON_ACCESS_TOKEN ?? ctx.env.NEON_ACCESS_TOKEN;
    const vercelTeamId =
      options?.vercelTeamId ?? process.env.VERCEL_TEAM_ID ?? ctx.env.VERCEL_TEAM_ID;
    const branch =
      options?.branch ??
      process.env.VERCEL_PREVIEW_BRANCH ??
      ctx.env.VERCEL_PREVIEW_BRANCH ??
      ctx.branch;
    let neonProjectId: string | undefined =
      options?.neonProjectId ?? process.env.NEON_PROJECT_ID ?? ctx.env.NEON_PROJECT_ID;
    const vercelNeonEnvVarPrefix = options?.vercelNeonEnvVarPrefix ?? VERCEL_NEON_ENV_VAR_PREFIX;

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

      let filteredEnvs: EnvVar[] = data.envs
        .filter((env: VercelEnvVar) => {
          if (!env.value) return false;
          if (!env.target.includes(vercelEnvironment)) return false;
          if (isBranchable && env.gitBranch && env.gitBranch !== branch) return false;
          return true;
        })
        .map((env: VercelEnvVar) => {
          return {
            name: env.key,
            value: env.value,
            isParentEnv: isBranchable && !env.gitBranch,
          };
        });

      // Discover NEON_PROJECT_ID from incoming Vercel env variables
      const neonProjectIdEnv = filteredEnvs.find((env) => env.name === NEON_PROJECT_ID_ENV_VAR);
      if (neonProjectIdEnv) {
        neonProjectId = neonProjectIdEnv.value;
      }

      // Keep a copy of the original env vars for the Neon API call (to extract credentials)
      const originalFilteredEnvs = [...filteredEnvs];

      // For non-production environments, filter out Neon env vars to avoid using production database
      // These will be replaced with branch-specific values from Neon API if available
      if (neonProjectId) {
        const neonEnvVarNames = new Set(
          NEON_ENV_VARS.map((name) => `${vercelNeonEnvVarPrefix}${name}`)
        );

        if (vercelEnvironment !== "production") {
          filteredEnvs = filteredEnvs.filter((env) => !neonEnvVarNames.has(env.name));
        }
      }

      // If we have neonProjectId, neonDbAccessToken, and branch, fetch Neon branch info and add env vars
      if (neonProjectId && neonDbAccessToken && branch && vercelEnvironment !== "production") {
        try {
          const neonBranchEnvVars = await fetchNeonBranchEnvVars({
            neonProjectId,
            neonDbAccessToken,
            branch,
            vercelEnvironment,
            filteredEnvs: originalFilteredEnvs,
            vercelNeonEnvVarPrefix,
          });
          if (neonBranchEnvVars) {
            // Override NEON_ENV_VARS in filteredEnvs with the new values
            for (const neonEnvVar of neonBranchEnvVars) {
              const existingIndex = filteredEnvs.findIndex((env) => env.name === neonEnvVar.name);
              if (existingIndex !== -1) {
                filteredEnvs[existingIndex] = neonEnvVar;
              } else {
                filteredEnvs.push(neonEnvVar);
              }
            }
          }
        } catch (neonError) {
          console.error("Error fetching Neon branch environment variables:", neonError);
          // Continue with original filteredEnvs if Neon API fails
        }
      }

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

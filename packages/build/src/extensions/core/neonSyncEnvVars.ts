import { BuildExtension } from "@trigger.dev/core/v3/build";
import { syncEnvVars } from "../core.js";

type EnvVar = { name: string; value: string; isParentEnv?: boolean };

type NeonBranch = {
  id: string;
  name: string;
};

type NeonEndpoint = {
  id: string;
  host: string;
  type: string;
};

type NeonDatabase = {
  id: number;
  name: string;
  owner_name: string;
};

type NeonRole = {
  name: string;
  password?: string;
};

// List of Neon DB related environment variables to sync
export const NEON_ENV_VARS = [
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

function buildNeonEnvVarMappings(options: {
  user: string;
  password: string;
  database: string;
  host: string;
  poolerHost: string;
}): Record<string, string> {
  const { user, password, database, host, poolerHost } = options;

  return {
    PGUSER: user,
    PGPASSWORD: password,
    PGDATABASE: database,
    PGHOST: poolerHost,
    PGHOST_UNPOOLED: host,
    POSTGRES_USER: user,
    POSTGRES_PASSWORD: password,
    POSTGRES_DATABASE: database,
    POSTGRES_HOST: poolerHost,
    DATABASE_URL: `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${poolerHost}/${database}?sslmode=require`,
    DATABASE_URL_UNPOOLED: `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}/${database}?sslmode=require`,
    POSTGRES_URL: `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${poolerHost}/${database}?sslmode=require`,
    POSTGRES_URL_NO_SSL: `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${poolerHost}/${database}`,
    POSTGRES_URL_NON_POOLING: `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}/${database}?sslmode=require`,
    POSTGRES_PRISMA_URL: `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${poolerHost}/${database}?sslmode=require&pgbouncer=true&connect_timeout=15`,
  };
}

export function syncNeonEnvVars(options?: {
  projectId?: string;
  /**
   * Neon API access token for authentication.
   * It's recommended to use the NEON_ACCESS_TOKEN environment variable instead of hardcoding this value.
   */
  neonAccessToken?: string;
  branch?: string;
  databaseName?: string;
  roleName?: string;
  envVarPrefix?: string;
}): BuildExtension {
  const sync = syncEnvVars(async (ctx) => {
    const projectId =
      options?.projectId ?? process.env.NEON_PROJECT_ID ?? ctx.env.NEON_PROJECT_ID;
    const neonAccessToken =
      options?.neonAccessToken ?? process.env.NEON_ACCESS_TOKEN ?? ctx.env.NEON_ACCESS_TOKEN;
    const branch = options?.branch ?? ctx.branch;
    const envVarPrefix = options?.envVarPrefix ?? "";
    const outputEnvVars = NEON_ENV_VARS;

    // Skip the whole process for Vercel environments
    if (ctx.env.VERCEL) {
      return [];
    }

    if (!projectId) {
      throw new Error(
        "syncNeonEnvVars: you did not pass in a projectId or set the NEON_PROJECT_ID env var."
      );
    }

    if (!neonAccessToken) {
      throw new Error(
        "syncNeonEnvVars: you did not pass in an neonAccessToken or set the NEON_ACCESS_TOKEN env var."
      );
    }

    // Skip branch-specific logic for production environment
    if (ctx.environment === "prod") {
      return [];
    }

    if (!branch) {
      throw new Error(
        "syncNeonEnvVars: you did not pass in a branch and no branch was detected from context."
      );
    }

    const environmentMap = {
      prod: "production",
      staging: "preview",
      dev: "development",
      preview: "preview",
    } as const;

    const environment = environmentMap[ctx.environment as keyof typeof environmentMap];

    if (!environment) {
      throw new Error(
        `Invalid environment '${ctx.environment}'. Expected 'prod', 'staging', 'dev', or 'preview'.`
      );
    }

    if (environment === "development") {
      // Skip syncing for development environment
      return [];
    }

    try {
      // Step 1: Search for the branch in Neon
      const branchSearchParams = new URLSearchParams({ search: branch });
      const branchesUrl = `https://console.neon.tech/api/v2/projects/${projectId}/branches?${branchSearchParams}`;
      const branchesResponse = await fetch(branchesUrl, {
        headers: {
          Authorization: `Bearer ${neonAccessToken}`,
        },
      });

      if (!branchesResponse.ok) {
        throw new Error(`Failed to fetch Neon branches: ${branchesResponse.status}`);
      }

      const branchesData = await branchesResponse.json();
      const branches: NeonBranch[] = branchesData.branches || [];

      if (branches.length === 0) {
        // No matching branch found
        return [];
      }

      // Neon branch names are prefixed with environment (e.g., "preview/branch-name")
      const expectedBranchName = `${environment}/${branch}`;
      const matchingBranch = branches.find(
        (b) => b.name === expectedBranchName || b.name === branch
      );

      if (!matchingBranch) {
        // No exact match found
        return [];
      }

      const neonBranchId = matchingBranch.id;

      // Step 2: Get endpoints for the branch
      const endpointsUrl = `https://console.neon.tech/api/v2/projects/${projectId}/branches/${neonBranchId}/endpoints`;
      const endpointsResponse = await fetch(endpointsUrl, {
        headers: {
          Authorization: `Bearer ${neonAccessToken}`,
        },
      });

      if (!endpointsResponse.ok) {
        throw new Error(`Failed to fetch Neon branch endpoints: ${endpointsResponse.status}`);
      }

      const endpointsData = await endpointsResponse.json();
      const endpoints: NeonEndpoint[] = endpointsData.endpoints || [];

      if (endpoints.length === 0) {
        return [];
      }

      // Find an endpoint with type containing 'write', or take the first one
      const writeEndpoint = endpoints.find((ep) => ep.type.includes("write"));
      const endpoint = writeEndpoint || endpoints[0];

      if (!endpoint) {
        return [];
      }

      // Step 3: Get databases for the branch
      const databasesUrl = `https://console.neon.tech/api/v2/projects/${projectId}/branches/${neonBranchId}/databases`;
      const databasesResponse = await fetch(databasesUrl, {
        headers: {
          Authorization: `Bearer ${neonAccessToken}`,
        },
      });

      if (!databasesResponse.ok) {
        throw new Error(`Failed to fetch Neon branch databases: ${databasesResponse.status}`);
      }

      const databasesData = await databasesResponse.json();
      const databases: NeonDatabase[] = databasesData.databases || [];

      if (databases.length === 0) {
        return [];
      }

      // Find the specified database or use the first one
      const targetDatabase = options?.databaseName
        ? databases.find((db) => db.name === options.databaseName)
        : databases[0];

      if (!targetDatabase) {
        throw new Error(
          `syncNeonEnvVars: Database '${options?.databaseName}' not found in branch.`
        );
      }

      // Step 4: Get the role (user) and password
      const targetRoleName = options?.roleName ?? targetDatabase.owner_name;
      const rolePasswordUrl = `https://console.neon.tech/api/v2/projects/${projectId}/branches/${neonBranchId}/roles/${targetRoleName}/reveal_password`;
      const rolePasswordResponse = await fetch(rolePasswordUrl, {
        headers: {
          Authorization: `Bearer ${neonAccessToken}`,
        },
      });

      if (!rolePasswordResponse.ok) {
        throw new Error(
          `Failed to fetch Neon role password: ${rolePasswordResponse.status}. Make sure the role '${targetRoleName}' exists and has a password.`
        );
      }

      const rolePasswordData: NeonRole = await rolePasswordResponse.json();
      const password = rolePasswordData.password;

      if (!password) {
        throw new Error(
          `syncNeonEnvVars: No password found for role '${targetRoleName}'. The role may not have a password set.`
        );
      }

      // Step 5: Build new environment variables based on the endpoint host
      const newHost = endpoint.host;
      const poolerHost = newHost.replace(/^([^.]+)\./, "$1-pooler.");

      const envVarMappings = buildNeonEnvVarMappings({
        user: targetRoleName,
        password,
        database: targetDatabase.name,
        host: newHost,
        poolerHost,
      });

      // Build output env vars
      const newEnvVars: EnvVar[] = [];

      for (const neonEnvVar of outputEnvVars) {
        const prefixedKey = `${envVarPrefix}${neonEnvVar}`;
        if (envVarMappings[neonEnvVar]) {
          newEnvVars.push({
            name: prefixedKey,
            value: envVarMappings[neonEnvVar],
          });
        }
      }

      return newEnvVars;
    } catch (error) {
      console.error("Error fetching Neon branch environment variables:", error);
      throw error;
    }
  });

  return {
    name: "SyncNeonEnvVarsExtension",
    async onBuildComplete(context, manifest) {
      await sync.onBuildComplete?.(context, manifest);
    },
  };
}

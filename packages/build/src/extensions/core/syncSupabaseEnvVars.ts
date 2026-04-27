import { tryCatch } from "@trigger.dev/core/v3";
import { BuildExtension } from "@trigger.dev/core/v3/build";
import { syncEnvVars } from "../core.js";

type EnvVar = { name: string; value: string; isParentEnv?: boolean };

type SupabaseBranch = {
  id: string;
  name: string;
  project_ref: string;
  parent_project_ref: string;
  is_default: boolean;
  git_branch: string;
  status: string;
};

type SupabaseBranchDetail = {
  ref: string;
  db_host: string;
  db_port: number;
  db_user: string;
  db_pass: string;
  jwt_secret: string;
  status: string;
};

type SupabaseApiKey = {
  name: string;
  api_key: string;
};

// List of Supabase related environment variables to sync
export const SUPABASE_ENV_VARS = [
  "DATABASE_URL",
  "POSTGRES_URL",
  "SUPABASE_DB_URL",
  "PGHOST",
  "PGPORT",
  "PGUSER",
  "PGPASSWORD",
  "PGDATABASE",
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_JWT_SECRET",
];

function buildSupabaseEnvVarMappings(options: {
  user: string;
  password: string;
  host: string;
  port: number;
  database: string;
  ref: string;
  jwtSecret: string;
  anonKey?: string;
  serviceRoleKey?: string;
}): Record<string, string> {
  const { user, password, host, port, database, ref, jwtSecret, anonKey, serviceRoleKey } = options;

  const connectionString = `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${database}?sslmode=require`;

  const mappings: Record<string, string> = {
    DATABASE_URL: connectionString,
    POSTGRES_URL: connectionString,
    SUPABASE_DB_URL: connectionString,
    PGHOST: host,
    PGPORT: String(port),
    PGUSER: user,
    PGPASSWORD: password,
    PGDATABASE: database,
    SUPABASE_URL: `https://${ref}.supabase.co`,
    SUPABASE_JWT_SECRET: jwtSecret,
  };

  if (anonKey) {
    mappings.SUPABASE_ANON_KEY = anonKey;
  }

  if (serviceRoleKey) {
    mappings.SUPABASE_SERVICE_ROLE_KEY = serviceRoleKey;
  }

  return mappings;
}

export function syncSupabaseEnvVars(options?: {
  projectId?: string;
  /**
   * Supabase Management API access token for authentication.
   * It's recommended to use the SUPABASE_ACCESS_TOKEN environment variable instead of hardcoding this value.
   */
  supabaseAccessToken?: string;
  branch?: string;
  envVarPrefix?: string;
}): BuildExtension {
  const sync = syncEnvVars(async (ctx) => {
    // Skip for development environments
    if (ctx.environment === "dev") {
      return [];
    }

    const projectId =
      options?.projectId ?? process.env.SUPABASE_PROJECT_ID ?? ctx.env.SUPABASE_PROJECT_ID;
    const supabaseAccessToken =
      options?.supabaseAccessToken ??
      process.env.SUPABASE_ACCESS_TOKEN ??
      ctx.env.SUPABASE_ACCESS_TOKEN;
    const branch = options?.branch ?? ctx.branch;
    const envVarPrefix = options?.envVarPrefix ?? "";
    const outputEnvVars = SUPABASE_ENV_VARS;

    // Skip the whole process for Vercel environments
    if (ctx.env.VERCEL) {
      return [];
    }

    if (!projectId) {
      throw new Error(
        "syncSupabaseEnvVars: you did not pass in a projectId or set the SUPABASE_PROJECT_ID env var."
      );
    }

    if (!supabaseAccessToken) {
      throw new Error(
        "syncSupabaseEnvVars: you did not pass in a supabaseAccessToken or set the SUPABASE_ACCESS_TOKEN env var."
      );
    }

    const headers = {
      Authorization: `Bearer ${supabaseAccessToken}`,
    };

    // Step 1: List branches
    const branchesUrl = `https://api.supabase.com/v1/projects/${projectId}/branches`;
    const [branchesFetchError, branchesResponse] = await tryCatch(
      fetch(branchesUrl, { headers })
    );

    if (branchesFetchError) {
      throw new Error(
        `syncSupabaseEnvVars: network error fetching branches from ${branchesUrl}: ${branchesFetchError.message}`
      );
    }

    if (!branchesResponse.ok) {
      throw new Error(
        `syncSupabaseEnvVars: failed to list branches from ${branchesUrl} (status ${branchesResponse.status})`
      );
    }

    const [branchesParseError, branches] = await tryCatch(
      branchesResponse.json() as Promise<SupabaseBranch[]>
    );

    if (branchesParseError) {
      throw new Error(
        `syncSupabaseEnvVars: failed to parse branches response from ${branchesUrl}: ${branchesParseError.message}`
      );
    }

    if (branches.length === 0) {
      return [];
    }

    // Step 2: Find the target branch based on environment
    let targetBranch: SupabaseBranch | undefined;

    if (ctx.environment === "prod") {
      targetBranch = branches.find((b) => b.is_default);

      if (!targetBranch) {
        throw new Error(
          "syncSupabaseEnvVars: no default Supabase branch found for the project."
        );
      }
    } else {
      if (!branch) {
        throw new Error(
          "syncSupabaseEnvVars: you did not pass in a branch and no branch was detected from context."
        );
      }

      targetBranch = branches.find((b) => b.git_branch === branch || b.name === branch);

      if (!targetBranch) {
        return [];
      }
    }

    // Step 3: Get branch configuration (connection details)
    const branchDetailUrl = `https://api.supabase.com/v1/branches/${targetBranch.id}`;
    const [detailFetchError, branchDetailResponse] = await tryCatch(
      fetch(branchDetailUrl, { headers })
    );

    if (detailFetchError) {
      throw new Error(
        `syncSupabaseEnvVars: network error fetching branch details from ${branchDetailUrl}: ${detailFetchError.message}`
      );
    }

    if (!branchDetailResponse.ok) {
      throw new Error(
        `syncSupabaseEnvVars: failed to fetch branch details from ${branchDetailUrl} (status ${branchDetailResponse.status})`
      );
    }

    const [detailParseError, branchDetail] = await tryCatch(
      branchDetailResponse.json() as Promise<SupabaseBranchDetail>
    );

    if (detailParseError) {
      throw new Error(
        `syncSupabaseEnvVars: failed to parse branch details response from ${branchDetailUrl}: ${detailParseError.message}`
      );
    }

    // Step 4: Get API keys for the branch project
    const apiKeysUrl = `https://api.supabase.com/v1/projects/${branchDetail.ref}/api-keys`;
    const [apiKeysFetchError, apiKeysResponse] = await tryCatch(
      fetch(apiKeysUrl, { headers })
    );

    let anonKey: string | undefined;
    let serviceRoleKey: string | undefined;

    if (apiKeysFetchError) {
      console.warn(
        `syncSupabaseEnvVars: failed to fetch API keys from ${apiKeysUrl}: ${apiKeysFetchError.message}`
      );
    } else if (!apiKeysResponse.ok) {
      console.warn(
        `syncSupabaseEnvVars: failed to fetch API keys from ${apiKeysUrl} (status ${apiKeysResponse.status})`
      );
    } else {
      const [apiKeysParseError, apiKeys] = await tryCatch(
        apiKeysResponse.json() as Promise<SupabaseApiKey[]>
      );

      if (apiKeysParseError) {
        console.warn(
          `syncSupabaseEnvVars: failed to parse API keys response from ${apiKeysUrl}: ${apiKeysParseError.message}`
        );
      } else {
        anonKey = apiKeys.find((k) => k.name === "anon")?.api_key;
        serviceRoleKey = apiKeys.find((k) => k.name === "service_role")?.api_key;
      }
    }

    // Step 5: Build environment variable mappings
    const envVarMappings = buildSupabaseEnvVarMappings({
      user: branchDetail.db_user,
      password: branchDetail.db_pass,
      host: branchDetail.db_host,
      port: branchDetail.db_port,
      database: "postgres",
      ref: branchDetail.ref,
      jwtSecret: branchDetail.jwt_secret,
      anonKey,
      serviceRoleKey,
    });

    const newEnvVars: EnvVar[] = [];

    for (const supabaseEnvVar of outputEnvVars) {
      const prefixedKey = `${envVarPrefix}${supabaseEnvVar}`;
      if (envVarMappings[supabaseEnvVar]) {
        newEnvVars.push({
          name: prefixedKey,
          value: envVarMappings[supabaseEnvVar],
        });
      }
    }

    return newEnvVars;
  });

  return {
    name: "SyncSupabaseEnvVarsExtension",
    async onBuildComplete(context, manifest) {
      await sync.onBuildComplete?.(context, manifest);
    },
  };
}

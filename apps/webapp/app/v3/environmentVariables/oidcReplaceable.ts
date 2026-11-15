// Env var keys that hold a long-lived credential for a service an OIDC setup guide covers. Matched
// by exact name (env var keys are case-sensitive); values are never read.
const OIDC_REPLACEABLE_SERVICES = [
  {
    id: "aws",
    name: "Amazon Web Services",
    keys: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"],
    guide: "oidc/aws",
    guideLabel: "AWS setup guide",
  },
  {
    id: "azure",
    name: "Microsoft Azure",
    keys: [
      "AZURE_CLIENT_SECRET",
      "AZURE_CLIENT_CERTIFICATE_PATH",
      "AZURE_CLIENT_CERTIFICATE_PASSWORD",
    ],
    guide: "oidc/azure",
    guideLabel: "Azure setup guide",
  },
  {
    id: "gcp",
    name: "Google Cloud",
    keys: ["GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CREDENTIALS"],
    guide: "oidc/gcp",
    guideLabel: "Google Cloud setup guide",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    keys: ["ANTHROPIC_API_KEY"],
    guide: "oidc/anthropic",
    guideLabel: "Anthropic setup guide",
  },
  {
    id: "infisical",
    name: "Infisical",
    keys: ["INFISICAL_CLIENT_ID", "INFISICAL_CLIENT_SECRET", "INFISICAL_TOKEN"],
    guide: "oidc/infisical",
    guideLabel: "Infisical setup guide",
  },
  {
    id: "vault",
    name: "HashiCorp Vault",
    keys: ["VAULT_TOKEN"],
    guide: "oidc/vault",
    guideLabel: "Vault setup guide",
  },
  {
    id: "doppler",
    name: "Doppler",
    keys: ["DOPPLER_TOKEN"],
    guide: "oidc/doppler",
    guideLabel: "Doppler setup guide",
  },
  {
    id: "snowflake",
    name: "Snowflake",
    keys: [
      "SNOWFLAKE_PASSWORD",
      "SNOWFLAKE_PRIVATE_KEY",
      "SNOWFLAKE_PRIVATE_KEY_PATH",
      "SNOWFLAKE_PRIVATE_KEY_PASSPHRASE",
    ],
    guide: "oidc/snowflake",
    guideLabel: "Snowflake setup guide",
  },
  {
    id: "databricks",
    name: "Databricks",
    keys: ["DATABRICKS_TOKEN", "DATABRICKS_CLIENT_SECRET"],
    guide: "oidc/databricks",
    guideLabel: "Databricks setup guide",
  },
  {
    id: "huggingface",
    name: "Hugging Face",
    keys: ["HF_TOKEN", "HUGGING_FACE_HUB_TOKEN", "HUGGINGFACEHUB_API_TOKEN"],
    guide: "oidc/hugging-face",
    guideLabel: "Hugging Face setup guide",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    keys: ["OPENROUTER_API_KEY"],
    guide: "oidc/openrouter",
    guideLabel: "OpenRouter setup guide",
  },
] as const;

export type OidcReplaceableService = (typeof OIDC_REPLACEABLE_SERVICES)[number];

export const OIDC_REPLACEABLE_KEYS: string[] = OIDC_REPLACEABLE_SERVICES.flatMap((service) => [
  ...service.keys,
]);

/** The service whose OIDC guide can replace `key`, if any. */
export function oidcServiceForKey(key: string): OidcReplaceableService | undefined {
  return OIDC_REPLACEABLE_SERVICES.find((service) =>
    (service.keys as readonly string[]).includes(key)
  );
}

type RootEnvironmentType = "STAGING" | "PREVIEW" | "PRODUCTION";
const ROOT_ORDER: RootEnvironmentType[] = ["STAGING", "PREVIEW", "PRODUCTION"];

export type OidcReplaceableKey = {
  key: string;
  /** The deployed environments (not branches) the key is set in, in the page's order. */
  environmentTypes: RootEnvironmentType[];
  /** How many preview branches set their own value. */
  previewBranches: number;
};

/**
 * Groups where keys are set by the service OIDC could replace them with, in the table's order.
 * Rows from Development are ignored.
 */
export function groupOidcReplaceable(
  rows: Array<{ key: string; environmentType: string; branchName: string | null }>
): Array<{ service: OidcReplaceableService; keys: OidcReplaceableKey[] }> {
  return OIDC_REPLACEABLE_SERVICES.map((service) => ({
    service,
    keys: service.keys.flatMap((key): OidcReplaceableKey[] => {
      const set = rows.filter((row) => row.key === key && row.environmentType !== "DEVELOPMENT");
      if (set.length === 0) {
        return [];
      }
      return [
        {
          key,
          environmentTypes: ROOT_ORDER.filter((type) =>
            set.some((row) => row.branchName === null && row.environmentType === type)
          ),
          previewBranches: set.filter((row) => row.branchName !== null).length,
        },
      ];
    }),
  })).filter((group) => group.keys.length > 0);
}

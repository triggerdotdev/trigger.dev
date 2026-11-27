// Ask AI settings, read per call. Pages are prerendered, so the provider's credentials must also
// be set at build time for the button to show. Free of the provider SDKs (the AWS STS client
// loads only when a role is assumed) so the layouts and the build script can import it. `env` is a parameter only so tests can pass their own.

import { awsCredentialsProvider } from "@vercel/functions/oidc";

type Env = Record<string, string | undefined>;

export type AskProvider = "anthropic" | "bedrock";

/** Which API Ask's model calls go through. Both speak Anthropic's Messages API. */
export const askProvider = (env: Env = process.env): AskProvider =>
  env.DOCS_ASK_MODEL_PROVIDER === "bedrock" ? "bedrock" : "anthropic";

/**
 * Canonical model id -> Bedrock us cross-region inference profile, from
 * `internal-packages/dashboard-agent/src/model-provider.ts` (`BEDROCK_MODEL_IDS`). Only models
 * that accept the `thinking: between_tools` that `lib/ask.ts` sends; the dashboard agent's other
 * entries reject it, so add one only together with its own thinking setting.
 */
const BEDROCK_MODEL_IDS: Record<string, string> = {
  "claude-sonnet-5-5": "us.anthropic.claude-sonnet-5-5",
};

// Where Ask calls the us. profiles from: the US commercial regions they list as sources. (They
// also accept the Canadian regions; Ask keeps to the US.)
const US_REGIONS = new Set(["us-east-1", "us-east-2", "us-west-1", "us-west-2"]);

// `||` treats an empty value as unset. The dedicated region wins over the global ones.
const bedrockRegion = (env: Env): string | undefined =>
  env.DOCS_ASK_AWS_REGION || env.AWS_REGION || env.AWS_DEFAULT_REGION || undefined;

const dedicatedKeys = (env: Env) => {
  const accessKeyId = env.DOCS_ASK_AWS_ACCESS_KEY_ID;
  const secretAccessKey = env.DOCS_ASK_AWS_SECRET_ACCESS_KEY;
  return accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : undefined;
};

type Credentials = { accessKeyId: string; secretAccessKey: string; sessionToken?: string };

/**
 * The Bedrock provider's settings: the region, and Ask's own credentials when set, in this order:
 * - `DOCS_ASK_AWS_ROLE_ARN`: assume that role with the deployment's Vercel OIDC token (production).
 *   The token is read when a question is asked, from the request's `x-vercel-oidc-token` header
 *   (the Vercel runtime puts it in the request context, so the route passes nothing), falling back
 *   to `VERCEL_OIDC_TOKEN` (set at build time). The role trusts only production deployments. The SDK
 *   asks for credentials on every model request, so each step of an answer makes one STS call.
 * - `DOCS_ASK_AWS_ACCESS_KEY_ID` / `SECRET_ACCESS_KEY`: a static IAM key pair (local dev).
 * Either one always wins: the empty `apiKey` stops the SDK from using an ambient
 * `AWS_BEARER_TOKEN_BEDROCK`, and the credential provider keeps an ambient `AWS_SESSION_TOKEN`
 * out of the signature. Without them the SDK uses `AWS_BEARER_TOKEN_BEDROCK` or
 * `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`.
 */
export function bedrockSettings(env: Env = process.env): {
  region?: string;
  apiKey?: string;
  credentialProvider?: () => Promise<Credentials>;
} {
  const region = bedrockRegion(env);
  const roleArn = env.DOCS_ASK_AWS_ROLE_ARN;
  const keys = dedicatedKeys(env);
  const credentialProvider = roleArn
    ? awsCredentialsProvider({ roleArn, clientConfig: { region } })
    : keys && (async () => keys);
  return { region, ...(credentialProvider ? { apiKey: "", credentialProvider } : {}) };
}

/**
 * The model id to call, or why Ask can't run: `{ id }` when the active provider has credentials
 * (and, on Bedrock, a US region and a profile for the model), else `{ error }`.
 */
export function askModelId(
  env: Env = process.env
): { id: string; error?: undefined } | { id?: undefined; error: string } {
  const model = env.ASK_AI_MODEL || "claude-sonnet-5-5";
  if (askProvider(env) === "anthropic") {
    return env.ANTHROPIC_API_KEY ? { id: model } : { error: "ANTHROPIC_API_KEY is not set" };
  }
  const hasCredentials =
    env.DOCS_ASK_AWS_ROLE_ARN ||
    dedicatedKeys(env) ||
    (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) ||
    env.AWS_BEARER_TOKEN_BEDROCK;
  if (!hasCredentials) return { error: "no AWS credentials for Bedrock" };
  const region = bedrockRegion(env);
  if (!region) return { error: "no AWS region for Bedrock" };
  if (!US_REGIONS.has(region))
    return { error: `Bedrock region ${region} can't call the us. inference profiles` };
  const id = BEDROCK_MODEL_IDS[model];
  // A guessed profile id is a guaranteed 404 on every question, so Ask stays off instead.
  return id ? { id } : { error: `no Bedrock model id for ASK_AI_MODEL "${model}"` };
}

/** Whether Ask AI can answer: the route, the Ask button and the production build preflight. */
export const askConfigured = (env: Env = process.env) => !askModelId(env).error;

import { afterEach, describe, expect, it, vi } from "vitest";
import { askConfigured, askModelId, askProvider, bedrockSettings } from "./ask-config";

const bedrock = {
  DOCS_ASK_MODEL_PROVIDER: "bedrock",
  DOCS_ASK_AWS_ACCESS_KEY_ID: "id",
  DOCS_ASK_AWS_SECRET_ACCESS_KEY: "secret",
  DOCS_ASK_AWS_REGION: "us-east-1",
};

describe("ask config", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("defaults to Anthropic and needs its key", () => {
    expect(askProvider({})).toBe("anthropic");
    expect(askConfigured({})).toBe(false);
    expect(askModelId({ ANTHROPIC_API_KEY: "k" })).toEqual({ id: "claude-sonnet-5-5" });
  });

  it("ignores the Anthropic key on Bedrock", () => {
    const env = {
      DOCS_ASK_MODEL_PROVIDER: "bedrock",
      ANTHROPIC_API_KEY: "k",
      AWS_REGION: "us-east-1",
    };
    expect(askModelId(env).error).toBe("no AWS credentials for Bedrock");
  });

  it("maps the canonical model to its Bedrock profile", () => {
    expect(askModelId(bedrock)).toEqual({ id: "us.anthropic.claude-sonnet-5-5" });
  });

  // Catches: a model that rejects Ask's thinking setting passing the build preflight.
  it("turns Ask off for a model with no Bedrock profile", () => {
    const env = { ...bedrock, ASK_AI_MODEL: "claude-haiku-4-5" };
    expect(askModelId(env).error).toBe('no Bedrock model id for ASK_AI_MODEL "claude-haiku-4-5"');
    expect(askConfigured(env)).toBe(false);
  });

  // Catches: a non-US region passing preflight, then every call to the us. profile failing.
  it("needs a US region on Bedrock, falling back to the global ones", () => {
    expect(askModelId({ ...bedrock, DOCS_ASK_AWS_REGION: "" }).error).toBe(
      "no AWS region for Bedrock"
    );
    expect(askConfigured({ ...bedrock, DOCS_ASK_AWS_REGION: "", AWS_REGION: "us-west-2" })).toBe(
      true
    );
    expect(askModelId({ ...bedrock, DOCS_ASK_AWS_REGION: "eu-west-1" }).error).toBe(
      "Bedrock region eu-west-1 can't call the us. inference profiles"
    );
    expect(askConfigured({ ...bedrock, DOCS_ASK_AWS_REGION: "us-gov-west-1" })).toBe(false);
  });

  // Catches: an ambient bearer token or session token overriding Ask's own IAM keys.
  it("makes the dedicated keys win over ambient AWS credentials", async () => {
    const settings = bedrockSettings({ ...bedrock, AWS_BEARER_TOKEN_BEDROCK: "t" });
    expect(settings.apiKey).toBe("");
    expect(await settings.credentialProvider?.()).toEqual({
      accessKeyId: "id",
      secretAccessKey: "secret",
    });
    const ambient = {
      DOCS_ASK_MODEL_PROVIDER: "bedrock",
      AWS_REGION: "us-east-1",
      AWS_BEARER_TOKEN_BEDROCK: "t",
    };
    expect(bedrockSettings(ambient)).toEqual({ region: "us-east-1" });
    expect(askConfigured(ambient)).toBe(true);
  });

  it("counts a role ARN alone as Bedrock credentials", () => {
    const env = {
      DOCS_ASK_MODEL_PROVIDER: "bedrock",
      DOCS_ASK_AWS_ROLE_ARN: "arn:aws:iam::123456789012:role/docs-ask",
      DOCS_ASK_AWS_REGION: "us-east-1",
    };
    expect(askConfigured(env)).toBe(true);
  });

  // Catches: the static keys (or ambient credentials) signing in production when a role is set.
  it("assumes the role before using the static keys", async () => {
    const settings = bedrockSettings({
      ...bedrock,
      DOCS_ASK_AWS_ROLE_ARN: "arn:aws:iam::123456789012:role/docs-ask",
      AWS_BEARER_TOKEN_BEDROCK: "t",
    });
    expect(settings.apiKey).toBe("");
    // An empty token (the request header is absent outside Vercel) fails before any STS call.
    vi.stubEnv("VERCEL_OIDC_TOKEN", "");
    await expect(settings.credentialProvider?.()).rejects.toThrow("x-vercel-oidc-token");
  });
});

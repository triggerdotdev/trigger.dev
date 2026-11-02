/** Verified claims from the internal run token that authenticated the mint request. */
export type ExternalOidcRunIdentity = {
  organizationId: string;
  projectId: string;
  environmentId: string;
  runId: string;
  attempt: number;
};

export type ExternalOidcEnvironment = {
  id: string;
  slug: string;
  type: string;
  organizationId: string;
  projectId: string;
  projectRef: string;
  orgFeatureFlags: unknown;
};

export type ExternalOidcSetup = { issuer: string; audience: string; subject: string };

export type ExternalOidcMintResult =
  | { ok: true; token: string }
  | {
      ok: false;
      code:
        | "INVALID_RUN_TOKEN"
        | "OIDC_PRIVATE_BETA"
        | "DEVELOPMENT_NOT_SUPPORTED"
        | "RUN_NOT_EXECUTING";
      message: string;
      status: 401 | 403;
    };

export interface ExternalOidcController {
  isEnabled(orgFeatureFlags: unknown): boolean;
  getSetup(environment: ExternalOidcEnvironment): ExternalOidcSetup;
  mint(params: { run: ExternalOidcRunIdentity; audience: string }): Promise<ExternalOidcMintResult>;
}

export type ExternalOidcPluginConfig = {
  issuer: string;
  signJwt: (
    payload: Record<string, unknown>,
    options: { audience: string; subject: string; expiresInSeconds: number }
  ) => Promise<string>;
  /** The run's live environment, or null if it is archived, deleted or does not match. */
  findEnvironment: (run: ExternalOidcRunIdentity) => Promise<ExternalOidcEnvironment | null>;
  /** The run's task, or null unless `run.attempt` is the run's current executing attempt. */
  findExecutingRun: (run: ExternalOidcRunIdentity) => Promise<{ taskId: string } | null>;
};

export interface ExternalOidcPlugin {
  create(config: ExternalOidcPluginConfig): ExternalOidcController;
}

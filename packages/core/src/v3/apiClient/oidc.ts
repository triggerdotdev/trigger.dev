import { z } from "zod/v4";
import { runTokenSelectionReason } from "../runToken.js";
import { taskContext } from "../task-context-api.js";
import { getEnvVar } from "../utils/getEnv.js";
import { zodfetch, type ApiRequestOptions } from "./core.js";
import { ApiError } from "./errors.js";

export type GetOIDCTokenOptions = {
  audience: string;
};

const OIDCTokenResponse = z.object({
  token: z.string().min(1),
  expiresAt: z
    .string()
    .datetime()
    .transform((value) => new Date(value)),
});

export class OIDCTokenError extends ApiError {
  override readonly cause?: ApiError;

  constructor(code: string, message: string, cause?: ApiError) {
    super(
      cause?.status,
      { code, message, param: cause?.param, type: cause?.type },
      undefined,
      cause?.headers,
      cause?.body
    );
    this.name = "OIDCTokenError";
    this.cause = cause;
  }
}

function currentRunToken(): string {
  if (!taskContext.isInsideTask || taskContext.ctx?.environment.type === "DEVELOPMENT") {
    throw new OIDCTokenError(
      "OIDC_NOT_IN_DEPLOYED_RUN",
      "OIDC is only available inside a deployed task run. Local development must use your own credentials."
    );
  }

  const token = getEnvVar("TRIGGER_RUN_TOKEN");
  if (!token) {
    throw new OIDCTokenError(
      "OIDC_RUN_TOKEN_MISSING",
      "OIDC requires a run token. Update your Trigger.dev CLI and redeploy. If the issue persists, ask support to enable OIDC for your organization. Local development must use your own credentials."
    );
  }

  // Unlike ordinary API calls, minting must never fall back to an environment key.
  const reason = runTokenSelectionReason(token, 0);
  if (reason === "expired_token") {
    throw new OIDCTokenError(
      "OIDC_RUN_TOKEN_EXPIRED",
      "The internal run token has expired. The runner must refresh it before requesting an OIDC token."
    );
  }
  if (reason !== "selected") {
    throw new OIDCTokenError(
      "OIDC_RUN_TOKEN_INVALID",
      "OIDC requires a valid internal run token with admin scope."
    );
  }

  return token;
}

export async function requestOIDCToken(
  options: GetOIDCTokenOptions,
  baseURL: string,
  requestOptions?: ApiRequestOptions
): Promise<z.infer<typeof OIDCTokenResponse>> {
  if (!options.audience.trim()) {
    throw new OIDCTokenError("OIDC_AUDIENCE_REQUIRED", "OIDC requires a nonempty audience.");
  }

  currentRunToken();
  try {
    return await zodfetch(
      OIDCTokenResponse,
      `${baseURL.replace(/\/$/, "")}/api/v1/auth/oidc/token`,
      {
        method: "POST",
        headers: { ...requestOptions?.additionalHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ audience: options.audience }),
      },
      {
        retry: requestOptions?.retry,
        resolveHeaders: () => ({ Authorization: `Bearer ${currentRunToken()}` }),
      }
    );
  } catch (error) {
    if (error instanceof OIDCTokenError) throw error;
    if (error instanceof ApiError) {
      throw new OIDCTokenError(error.code ?? "OIDC_REQUEST_FAILED", error.message, error);
    }
    throw error;
  }
}

import { AssumeRoleWithWebIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { taskContext } from "@trigger.dev/core/v3";
import { auth } from "../auth.js";

const DEFAULT_DURATION_SECONDS = 60 * 60;
const MAX_ROLE_SESSION_NAME_LENGTH = 64;

export type AWSCredentialProviderOptions = {
  roleArn: string;
  region: string;
  /** Defaults to the current run ID, sanitized and limited to 64 characters. */
  roleSessionName?: string;
  /** STS session duration, in seconds. Defaults to one hour. */
  durationSeconds?: number;
};

export type AWSCredentials = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration: Date;
};

/**
 * Pass directly as an AWS SDK client's credentials option.
 * The AWS SDK caches credentials and calls this provider again before expiration.
 * Create the AWS client inside `run` and reuse it only within that run. Module-scope
 * clients can reuse a previous run's credentials and AWS session attribution.
 * Install the optional peer @aws-sdk/client-sts to use this subpath.
 */
export function awsCredentialProvider(
  options: AWSCredentialProviderOptions
): () => Promise<AWSCredentials> {
  const client = new STSClient({ region: options.region });

  return async () => {
    const { token } = await auth.getOIDCToken({ audience: "sts.amazonaws.com" });
    const roleSessionName =
      options.roleSessionName ??
      taskContext.ctx!.run.id.replace(/[^\w+=,.@-]/g, "_").slice(0, MAX_ROLE_SESSION_NAME_LENGTH);
    const { Credentials } = await client.send(
      new AssumeRoleWithWebIdentityCommand({
        RoleArn: options.roleArn,
        RoleSessionName: roleSessionName,
        DurationSeconds: options.durationSeconds ?? DEFAULT_DURATION_SECONDS,
        WebIdentityToken: token,
      })
    );

    if (
      !Credentials?.AccessKeyId ||
      !Credentials.SecretAccessKey ||
      !Credentials.SessionToken ||
      !Credentials.Expiration ||
      !Number.isFinite(Credentials.Expiration.getTime())
    ) {
      throw new Error("AWS STS did not return complete temporary credentials with an expiration.");
    }

    return {
      accessKeyId: Credentials.AccessKeyId,
      secretAccessKey: Credentials.SecretAccessKey,
      sessionToken: Credentials.SessionToken,
      expiration: Credentials.Expiration,
    };
  };
}

export type OidcSetupIdentity = {
  issuer: string;
  audience: string;
  subject: string;
};

export function awsOidcTrustPolicy(identity: OidcSetupIdentity, accountId: string) {
  const provider = new URL(identity.issuer).host;

  return JSON.stringify(
    {
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Principal: {
            Federated: `arn:aws:iam::${accountId}:oidc-provider/${provider}`,
          },
          Action: "sts:AssumeRoleWithWebIdentity",
          Condition: {
            StringEquals: {
              [`${provider}:aud`]: identity.audience,
              [`${provider}:sub`]: identity.subject,
            },
          },
        },
      ],
    },
    null,
    2
  );
}

export const AWS_S3_READ_PERMISSIONS = JSON.stringify(
  {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: "s3:GetObject",
        Resource: "arn:aws:s3:::YOUR_BUCKET/trigger/*",
      },
    ],
  },
  null,
  2
);

export function awsOidcTaskExample(accountId: string) {
  return `import { task } from "@trigger.dev/sdk";
import { awsCredentialProvider } from "@trigger.dev/sdk/oidc/aws";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";

export const readFromS3 = task({
  id: "read-from-s3",
  run: async () => {
    // Create the AWS client inside run, not at module scope.
    const s3 = new S3Client({
      region: "us-east-1",
      credentials: awsCredentialProvider({
        roleArn: "arn:aws:iam::${accountId}:role/trigger-s3-reader",
        region: "us-east-1",
      }),
    });

    const result = await s3.send(
      new GetObjectCommand({ Bucket: "YOUR_BUCKET", Key: "trigger/example.txt" })
    );
    return { contents: await result.Body?.transformToString() };
  },
});`;
}

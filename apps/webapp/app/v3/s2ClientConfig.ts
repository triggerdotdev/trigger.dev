import { S2 } from "@s2-dev/streamstore";

export type DeploymentS2Config = {
  accessToken: string;
  endpoint?: string;
};

type DeploymentS2ClientOptions = {
  accessToken: string;
  endpoints?: { account: string; basin: string };
};

// Exported so a test can pin the shape handed to the SDK: with no endpoint the options must carry
// no `endpoints` key, matching the call production already makes.
export function deploymentS2ClientOptions({
  accessToken,
  endpoint,
}: DeploymentS2Config): DeploymentS2ClientOptions {
  if (endpoint === undefined) {
    return { accessToken };
  }

  // One value drives both hosts. Overriding just one would send the access token to the hosted
  // service while the other half went elsewhere.
  return { accessToken, endpoints: { account: endpoint, basin: endpoint } };
}

export function buildDeploymentS2Client(config: DeploymentS2Config): S2 {
  return new S2(deploymentS2ClientOptions(config));
}

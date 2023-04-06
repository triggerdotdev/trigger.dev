import { ClientFactory } from "@trigger.dev/sdk";
import { Octokit } from "octokit";

export const clientFactory: ClientFactory<InstanceType<typeof Octokit>> = (
  auth
) => {
  if (auth.type === "basicAuth") {
    throw new Error("Basic auth is not supported");
  }

  const token = auth.type === "apiKey" ? auth.apiKey : auth.accessToken;

  return new Octokit({
    auth: token,
    baseUrl: (auth.additionalFields ?? {})["baseUrl"],
  });
};

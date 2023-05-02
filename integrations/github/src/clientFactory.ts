import { ClientFactory } from "@trigger.dev/sdk";
import { Octokit } from "octokit";

export const clientFactory: ClientFactory<Octokit> = (auth) => {
  return new Octokit({
    auth: auth.accessToken,
  });
};

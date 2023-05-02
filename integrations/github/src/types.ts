import { ClientFactory } from "@trigger.dev/sdk";
import { Octokit } from "octokit";

export type ClientOptions =
  | {
      usesLocalAuth: true;
      octokit: Octokit;
    }
  | {
      usesLocalAuth: false;
      clientFactory: ClientFactory<Octokit>;
    };

import { ConnectionAuth, IntegrationMetadata } from "@trigger.dev/core";
import { IO } from "./io";

export type ClientFactory<TClient> = (auth: ConnectionAuth) => TClient;

export interface TriggerIntegration {
  id: string;
  metadata: IntegrationMetadata;
  authSource: "LOCAL" | "HOSTED";
}

//todo options.integration.authSource = "LOCAL" | "HOSTED"
//todo an integration will get given the auth, in constructor directly via an API key, or from in each task

export type IOWithIntegrations<TIntegrations extends Record<string, TriggerIntegration>> = IO &
  TIntegrations;

export type IntegrationTaskKey = string | any[];

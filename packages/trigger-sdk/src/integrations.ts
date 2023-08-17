import { ConnectionAuth, IntegrationMetadata } from "@trigger.dev/core";
import { IO } from "./io";
export type { ConnectionAuth } from "@trigger.dev/core";

export interface TriggerIntegration extends Object {
  id: string;
  metadata: IntegrationMetadata;
  authSource: "LOCAL" | "HOSTED";
  cloneForRun: (io: IO, auth?: ConnectionAuth) => TriggerIntegration;
}

export type IOWithIntegrations<TIntegrations extends Record<string, TriggerIntegration>> = IO &
  TIntegrations;

export type IntegrationTaskKey = string | any[];

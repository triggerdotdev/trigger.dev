import { ConnectionAuth, IntegrationMetadata } from "@trigger.dev/core";
import { IO } from "./io";
import { Prettify } from "@trigger.dev/core";
export type { ConnectionAuth } from "@trigger.dev/core";

export interface TriggerIntegration {
  id: string;
  metadata: IntegrationMetadata;
  authSource: "LOCAL" | "HOSTED";
  cloneForRun: (io: IO, connectionKey: string, auth?: ConnectionAuth) => TriggerIntegration;
}

export type IOWithIntegrations<TIntegrations extends Record<string, TriggerIntegration>> = IO &
  TIntegrations;

export type IntegrationTaskKey = string | any[];

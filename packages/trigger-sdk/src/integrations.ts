import { ConnectionAuth, IntegrationMetadata } from "@trigger.dev/core";
import { IO } from "./io";
export type { ConnectionAuth } from "@trigger.dev/core";

export interface TriggerIntegration {
  id: string;
  metadata: IntegrationMetadata;
  authSource: "LOCAL" | "HOSTED";
  //these must be implemented internally, but are hidden from the user
  _options: any;
  _client?: any;
  _io?: IO;
  cloneForRun: (io: IO, auth?: ConnectionAuth) => TriggerIntegration;
}

//This strips the internal properties from the integrations
type OmitInternalProperties<T> = {
  [P in keyof T]: Omit<T[P], "_options" | "_client" | "_io" | "cloneForRun">;
};

export type IOWithIntegrations<TIntegrations extends Record<string, TriggerIntegration>> = IO &
  OmitInternalProperties<TIntegrations>;

export type IntegrationTaskKey = string | any[];

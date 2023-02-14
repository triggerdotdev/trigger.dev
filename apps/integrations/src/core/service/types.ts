import { Action } from "core/action/types";
import { IntegrationAuthentication } from "core/authentication/types";

export type Service = {
  name: string;
  service: string;
  version: string;
  authentication: IntegrationAuthentication;
  actions: Record<string, Action>;
  retryableStatusCodes: number[];
};

import { Action } from "core/action/types";
import { IntegrationAuthentication } from "core/authentication/types";
import { Webhook } from "core/webhook/types";

export type Service = {
  name: string;
  service: string;
  version: string;
  baseUrl: string;
  live: boolean;
  authentication: IntegrationAuthentication;
  actions?: Record<string, Action>;
  webhooks?: Record<string, Webhook>;
  retryableStatusCodes: number[];
};

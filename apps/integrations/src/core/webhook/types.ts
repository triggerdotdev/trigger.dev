import {
  AuthCredentials,
  IntegrationAuthentication,
} from "core/authentication/types";
import { EndpointSpec } from "core/endpoint/types";
import { HTTPMethod, HTTPResponse } from "core/request/types";

export type Webhook = {
  baseUrl: string;
  spec: WebhookSpec;
  authentication: IntegrationAuthentication;
  events: WebhookEvent[];
  subscribe: (
    data: WebhookSubscriptionRequest
  ) => Promise<WebhookSubscriptionResult>;
  receive: (
    data: WebhookReceiveRequest
  ) => Promise<{ eventResults?: WebhookEventResult[]; response: HTTPResponse }>;
};

export type WebhookSpec = {
  id: string;
  metadata: WebhookMetadata;
  events: string[];
  subscribe: WebhookSpecSubscribe;
};

export type WebhookMetadata = {
  name: string;
  description: string;
  displayProperties: {
    title: string;
  };
  externalDocs?: ExternalDocs;
  tags: string[];
};

type ExternalDocs = {
  description: string;
  url: string;
};

export type WebhookSpecSubscribe =
  | WebhookSpecSubscribeManual
  | WebhookSpecSubscribeAutomatic;

type WebhookSpecSubscribeManual = {
  type: "manual";
};

export interface WebhookSpecSubscribeAutomatic {
  type: "automatic";
  create: EndpointSpec;
  //todo delete: EndpointSpec;
}

export type WebhookSubscriptionRequest = {
  credentials?: AuthCredentials;
  callbackUrl: string;
  events: string[];
  secret?: string;
  inputData: Record<string, any>;
};

export type WebhookSubscriptionResult =
  | {
      success: true;
      callbackUrl: string;
      events: string[];
      secret?: string;
      status: number;
      headers?: Record<string, string>;
      data: any;
    }
  | {
      success: false;
      error: string;
    };

export type WebhookReceiveRequest = {
  credentials?: AuthCredentials;
  secret?: string;
  subscriptionData: Record<string, any>;
  request: WebhookIncomingRequest;
};

export type WebhookIncomingRequest = {
  method: HTTPMethod;
  searchParams: URLSearchParams;
  headers: Record<string, string>;
  body: any;
  rawBody: Buffer;
};

export type WebhookEvent = {
  name: string;
  matches: (data: {
    subscriptionData: Record<string, any>;
    request: WebhookIncomingRequest;
  }) => boolean;
  process: (data: WebhookReceiveRequest) => Promise<WebhookEventResult[]>;
};

export type WebhookEventResult = {
  event: string;
  payload: any;
};

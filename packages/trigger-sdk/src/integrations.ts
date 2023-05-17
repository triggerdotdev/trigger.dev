import {
  ConnectionAuth,
  IntegrationMetadata,
  RunTaskOptions,
  ServerTask,
} from "@trigger.dev/internal";
import { IO } from "./io";

export type ClientFactory<TClient> = (auth: ConnectionAuth) => TClient;

export interface TriggerIntegration<
  TIntegrationClient extends IntegrationClient<any, any> = IntegrationClient<
    any,
    any
  >
> {
  client: TIntegrationClient;
  id: string;
  metadata: IntegrationMetadata;
}

export type IntegrationClient<
  TClient,
  TTasks extends Record<string, AuthenticatedTask<TClient, any, any>>
> =
  | {
      usesLocalAuth: true;
      client: TClient;
      tasks?: TTasks;
    }
  | {
      usesLocalAuth: false;
      clientFactory: ClientFactory<TClient>;
      tasks?: TTasks;
    };

export type AuthenticatedTask<TClient, TParams, TResult> = {
  run: (
    params: TParams,
    client: TClient,
    task: ServerTask,
    io: IO
  ) => Promise<TResult>;
  init: (params: TParams) => RunTaskOptions;
};

export function authenticatedTask<TClient, TParams, TResult>(options: {
  run: (
    params: TParams,
    client: TClient,
    task: ServerTask,
    io: IO
  ) => Promise<TResult>;
  init: (params: TParams) => RunTaskOptions;
}): AuthenticatedTask<TClient, TParams, TResult> {
  return options;
}

type ExtractRunFunction<T> = T extends AuthenticatedTask<
  any,
  infer TParams,
  infer TResult
>
  ? (key: string, params: TParams) => Promise<TResult>
  : never;

type ExtractTasks<
  TTasks extends Record<string, AuthenticatedTask<any, any, any>>
> = {
  [key in keyof TTasks]: ExtractRunFunction<TTasks[key]>;
};

type ExtractIntegrationClientClient<
  TIntegrationClient extends IntegrationClient<any, any>
> = TIntegrationClient extends {
  usesLocalAuth: true;
  client: infer TClient;
}
  ? { client: TClient }
  : TIntegrationClient extends {
      usesLocalAuth: false;
      clientFactory: ClientFactory<infer TClient>;
    }
  ? TClient
  : never;

type ExtractIntegrationClient<
  TIntegrationClient extends IntegrationClient<any, any>
> = ExtractIntegrationClientClient<TIntegrationClient> &
  ExtractTasks<TIntegrationClient["tasks"]>;

type ExtractIntegrations<
  TIntegrations extends Record<
    string,
    TriggerIntegration<IntegrationClient<any, any>>
  >
> = {
  [key in keyof TIntegrations]: ExtractIntegrationClient<
    TIntegrations[key]["client"]
  >;
};

export type IOWithIntegrations<
  TIntegrations extends Record<
    string,
    TriggerIntegration<IntegrationClient<any, any>>
  >
> = IO & ExtractIntegrations<TIntegrations>;

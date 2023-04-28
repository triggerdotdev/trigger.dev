import {
  ConnectionAuth,
  ConnectionMetadata,
  RunTaskOptions,
  ServerTask,
} from "@trigger.dev/internal";
import { IO } from "./io";
import { TriggerClient } from "./triggerClient";
import { Trigger } from "./triggers";

export type ClientFactory<TClientType> = (auth: ConnectionAuth) => TClientType;

export type Connection<
  TClientType,
  TTasks extends Record<string, AuthenticatedTask<TClientType, any, any>>
> = {
  usesLocalAuth: boolean;
  metadata: ConnectionMetadata;
  clientFactory?: ClientFactory<TClientType>;
  client?: TClientType;
  tasks?: TTasks;
  id?: string;
  [key: string]: any;
};

export type ConnectionEvent<TParams, TEvent> = {
  trigger: (params: TParams) => Trigger<TEvent>;
  register: (client: TriggerClient, params: TParams) => Promise<any>;
};

export type AuthenticatedTask<TClientType, TParams, TResult> = {
  run: (
    params: TParams,
    client: TClientType,
    task: ServerTask,
    io: IO
  ) => Promise<TResult>;
  init: (params: TParams) => RunTaskOptions;
};

export function authenticatedTask<TClientType, TParams, TResult>(options: {
  run: (
    params: TParams,
    client: TClientType,
    task: ServerTask,
    io: IO
  ) => Promise<TResult>;
  init: (params: TParams) => RunTaskOptions;
}): AuthenticatedTask<TClientType, TParams, TResult> {
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

type ExtractClient<
  TClientFactory extends ClientFactory<any> | undefined,
  TClient extends any | undefined
> = TClientFactory extends ClientFactory<infer TClientType>
  ? { client: TClientType }
  : TClient extends any
  ? { client: TClient }
  : never;

type ExtractConnection<TConnection extends Connection<any, any>> = ExtractTasks<
  TConnection["tasks"]
> &
  ExtractClient<TConnection["clientFactory"], TConnection["client"]>;

type ExtractConnections<
  TConnections extends Record<string, Connection<any, any>>
> = {
  [key in keyof TConnections]: ExtractConnection<TConnections[key]>;
};

export type IOWithConnections<
  TConnections extends Record<string, Connection<any, any>>
> = IO & ExtractConnections<TConnections>;

import {
  ConnectionAuth,
  ConnectionConfig,
  ConnectionMetadata,
  RunTaskOptions,
  ServerTask,
} from "@trigger.dev/internal";
import { IO } from "./io";
import { TriggerClient } from "./triggerClient";
import { EventSpecification, Trigger } from "./types";

export type ClientFactory<TClientType> = (auth: ConnectionAuth) => TClientType;

export type Connection<
  TClientType,
  TTasks extends Record<string, AuthenticatedTask<TClientType, any, any>>
> =
  | {
      usesLocalAuth: true;
      metadata: ConnectionMetadata;
      client: TClientType;
      tasks?: TTasks;
      id?: string;
      [key: string]: any;
    }
  | {
      usesLocalAuth: false;
      metadata: ConnectionMetadata;
      clientFactory: ClientFactory<TClientType>;
      tasks?: TTasks;
      id?: string;
      [key: string]: any;
    };

export function connectionConfig(
  connection: Connection<any, any>
): ConnectionConfig | undefined {
  if (connection.usesLocalAuth) {
    return;
  }

  return {
    metadata: connection.metadata,
    id: connection.id!,
  };
}

export type ConnectionEvent<TParams, TEvent> = {
  trigger: (params: TParams) => Trigger<EventSpecification<TEvent>>;
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

type ExtractClient<TConnection extends Connection<any, any>> =
  TConnection extends {
    usesLocalAuth: true;
    client: infer TClient;
  }
    ? { client: TClient }
    : TConnection extends {
        usesLocalAuth: false;
        clientFactory: ClientFactory<infer TClientType>;
      }
    ? { client: TClientType }
    : never;

type ExtractConnection<TConnection extends Connection<any, any>> = ExtractTasks<
  TConnection["tasks"]
> &
  ExtractClient<TConnection>;

type ExtractConnections<
  TConnections extends Record<string, Connection<any, any>>
> = {
  [key in keyof TConnections]: ExtractConnection<TConnections[key]>;
};

export type IOWithConnections<
  TConnections extends Record<string, Connection<any, any>>
> = IO & ExtractConnections<TConnections>;

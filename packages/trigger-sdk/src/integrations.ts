import { ConnectionAuth, IntegrationMetadata, RunTaskOptions, ServerTask } from "@trigger.dev/core";
import { IO, IOTask } from "./io";

type IntegrationRunTaskFunction<TClient> = <TResult>(
  key: string | any[],
  callback: (client: TClient, task: IOTask, io: IO) => Promise<TResult>,
  options?: RunTaskOptions
) => Promise<TResult>;

export type ClientFactory<TClient> = (auth: ConnectionAuth) => TClient;

export interface TriggerIntegration<
  TIntegrationClient extends IntegrationClient<any, any> = IntegrationClient<any, any>,
> {
  client: TIntegrationClient;
  id: string;
  metadata: IntegrationMetadata;
}

// export type IntegrationTask<TParams

export type IntegrationClient<TClient, TTasks extends Record<string, any>> =
  | {
      usesLocalAuth: true;
      client: TClient;
      tasks?: TTasks;
      auth: any;
    }
  | {
      usesLocalAuth: false;
      clientFactory: ClientFactory<TClient>;
      tasks?: TTasks;
    };

type ExtractIntegrationClientClient<TIntegrationClient extends IntegrationClient<any, any>> =
  TIntegrationClient extends {
    usesLocalAuth: true;
    client: infer TClient;
  }
    ? {
        client: TClient;
        runTask: IntegrationRunTaskFunction<TClient>;
      }
    : TIntegrationClient extends {
        usesLocalAuth: false;
        clientFactory: ClientFactory<infer TClient>;
      }
    ? {
        client: TClient;
        runTask: IntegrationRunTaskFunction<TClient>;
      }
    : never;

type ExtractIntegrationClient<TIntegrationClient extends IntegrationClient<any, any>> =
  ExtractIntegrationClientClient<TIntegrationClient> & { tasks: TIntegrationClient["tasks"] };

export type IntegrationIO<TIntegration extends TriggerIntegration<IntegrationClient<any, any>>> =
  ExtractIntegrationClient<TIntegration["client"]>;

type ExtractIntegrations<
  TIntegrations extends Record<string, TriggerIntegration<IntegrationClient<any, any>>>,
> = {
  [key in keyof TIntegrations]: ExtractIntegrationClient<TIntegrations[key]["client"]>;
};

export type IOWithIntegrations<
  TIntegrations extends Record<string, TriggerIntegration<IntegrationClient<any, any>>>,
> = IO & ExtractIntegrations<TIntegrations>;

export type IntegrationTaskKey = string | any[];

export type IOWithIntegration<TriggerIntegration> = IO &
  ExtractIntegrationClientClient<TriggerIntegration>;

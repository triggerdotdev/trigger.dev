import { ConnectionAuth, RunTaskOptions } from "@trigger.dev/core";
import { IOWithIntegrations, IntegrationClient, TriggerIntegration } from "./integrations";
import { IO } from "./io";

export function createIOWithIntegrations<
  TIntegrations extends Record<string, TriggerIntegration<IntegrationClient<any, any>>>,
>(
  io: IO,
  auths?: Record<string, ConnectionAuth | undefined>,
  integrations?: TIntegrations
): IOWithIntegrations<TIntegrations> {
  if (!integrations) {
    return io as IOWithIntegrations<TIntegrations>;
  }

  const connections = Object.entries(integrations).reduce((acc, [connectionKey, integration]) => {
    let auth = auths?.[connectionKey];

    const client = integration.client.usesLocalAuth
      ? integration.client.client
      : auth
      ? integration.client.clientFactory?.(auth)
      : undefined;

    if (!client) {
      return acc;
    }

    auth = integration.client.usesLocalAuth ? integration.client.auth : auth;

    const ioConnection = {
      client,
    } as any;

    ioConnection.runTask = async (
      key: string | any[],
      callback: (client: any, task: any, io: IO) => Promise<any>,
      options?: RunTaskOptions
    ) => {
      return await io.runTask(
        key,
        {
          name: "Task",
          icon: integration.metadata.id,
          retry: {
            limit: 10,
            minTimeoutInMs: 1000,
            maxTimeoutInMs: 30000,
            factor: 2,
            randomize: true,
          },
          ...options,
        },
        async (ioTask) => {
          return await callback(client, ioTask, io);
        }
      );
    };

    if (integration.client.tasks) {
      const tasks: Record<string, any> = integration.client.tasks;
      Object.keys(tasks).forEach((taskName) => {
        ioConnection[taskName] = tasks[taskName];
      });
    }

    acc[connectionKey] = ioConnection;

    return acc;
  }, {} as any);

  return new Proxy(io, {
    get(target, prop, receiver) {
      // We can return the original io back if the prop is __io
      if (prop === "__io") {
        return io;
      }

      if (prop in connections) {
        return connections[prop];
      }

      const value = Reflect.get(target, prop, receiver);
      return typeof value == "function" ? value.bind(target) : value;
    },
  }) as IOWithIntegrations<TIntegrations>;
}

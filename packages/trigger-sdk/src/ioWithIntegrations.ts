import { ConnectionAuth } from "@trigger.dev/internal";
import {
  TriggerIntegration,
  IntegrationClient,
  IOWithIntegrations,
  AuthenticatedTask,
} from "./integrations";
import { IO } from "./io";

export function createIOWithIntegrations<
  TIntegrations extends Record<
    string,
    TriggerIntegration<IntegrationClient<any, any>>
  >
>(
  io: IO,
  auths?: Record<string, ConnectionAuth | undefined>,
  integrations?: TIntegrations
): IOWithIntegrations<TIntegrations> {
  if (!integrations) {
    return io as IOWithIntegrations<TIntegrations>;
  }

  const connections = Object.entries(integrations).reduce(
    (acc, [key, integration]) => {
      const connection = auths?.[key];
      const client =
        "client" in integration.client
          ? integration.client.client
          : connection
          ? integration.client.clientFactory?.(connection)
          : undefined;

      if (!client) {
        return acc;
      }

      const ioConnection = {
        client,
      } as any;

      if (integration.client.tasks) {
        const tasks: Record<
          string,
          AuthenticatedTask<any, any, any>
        > = integration.client.tasks;

        Object.keys(tasks).forEach((taskName) => {
          const authenticatedTask = tasks[taskName];

          ioConnection[taskName] = async (
            key: string | string[],
            params: any
          ) => {
            return await io.runTask(
              key,
              authenticatedTask.init(params),
              async (ioTask) => {
                return authenticatedTask.run(params, client, ioTask, io);
              }
            );
          };
        });
      }

      acc[key] = ioConnection;

      return acc;
    },
    {} as any
  );

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

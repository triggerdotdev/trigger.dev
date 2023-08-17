import { ConnectionAuth } from "@trigger.dev/core";
import { IOWithIntegrations, TriggerIntegration } from "./integrations";
import { IO } from "./io";

export function createIOWithIntegrations<TIntegrations extends Record<string, TriggerIntegration>>(
  io: IO,
  auths?: Record<string, ConnectionAuth | undefined>,
  integrations?: TIntegrations
): IOWithIntegrations<TIntegrations> {
  if (!integrations) {
    return io as IOWithIntegrations<TIntegrations>;
  }

  const connections = Object.entries(integrations).reduce(
    (acc, [connectionKey, integration]) => {
      let auth = auths?.[connectionKey];

      acc[connectionKey] = {
        integration,
        auth,
      };

      return acc;
    },
    {} as Record<
      string,
      {
        integration: TriggerIntegration;
        auth?: ConnectionAuth;
      }
    >
  );

  return new Proxy(io, {
    get(target, prop, receiver) {
      // We can return the original io back if the prop is __io
      if (prop === "__io") {
        return io;
      }

      if (typeof prop === "string" && prop in connections) {
        const { integration, auth } = connections[prop];
        return integration.cloneForRun(io, auth);
      }

      const value = Reflect.get(target, prop, receiver);
      return typeof value == "function" ? value.bind(target) : value;
    },
  }) as IOWithIntegrations<TIntegrations>;
}

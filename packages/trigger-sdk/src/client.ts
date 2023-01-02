import { v4 } from "uuid";
import { z } from "zod";
import { TimeoutError, HostConnection } from "./connection";
import { WebSocket } from "ws";
import {
  ZodRPC,
  ServerRPCSchema,
  HostRPCSchema,
  Logger,
} from "internal-bridge";
import * as pkg from "../package.json";
import { Trigger, TriggerOptions } from "./trigger";
import { TriggerContext, WaitForOptions } from "./types";
import { ContextLogger } from "./logger";
import { triggerRunLocalStorage } from "./localStorage";
import { ulid } from "ulid";

export class TriggerClient<TSchema extends z.ZodTypeAny> {
  #trigger: Trigger<TSchema>;
  #options: TriggerOptions<TSchema>;

  #connection?: HostConnection;
  #serverRPC?: ZodRPC<typeof ServerRPCSchema, typeof HostRPCSchema>;

  #apiKey: string;
  #endpoint: string;

  #isConnected = false;
  #retryIntervalMs: number = 3000;
  #logger: Logger;

  #responseCompleteCallbacks = new Map<
    string,
    {
      resolve: (output: any) => void;
      reject: (err?: any) => void;
    }
  >();

  #waitForCallbacks = new Map<
    string,
    {
      resolve: () => void;
      reject: (err?: any) => void;
    }
  >();

  constructor(trigger: Trigger<TSchema>, options: TriggerOptions<TSchema>) {
    this.#trigger = trigger;
    this.#options = options;

    const apiKey = this.#options.apiKey ?? process.env.TRIGGER_API_KEY;

    if (!apiKey) {
      throw new Error(
        "Cannot connect to Trigger because of invalid API Key: Please include an API Key in the `apiKey` option or in the `TRIGGER_API_KEY` environment variable."
      );
    }

    this.#apiKey = apiKey;
    this.#endpoint = this.#options.endpoint ?? "ws://trigger.dev/ws";
    this.#logger = new Logger("trigger.dev", this.#options.logLevel ?? "info");
  }

  async listen(instanceId?: string) {
    await this.#initializeConnection(instanceId);
    this.#initializeRPC();
    this.#initializeHost();
  }

  async #initializeConnection(instanceId?: string) {
    const id = instanceId ?? v4();

    this.#logger.debug("Initializing connection...", id);

    const headers = { Authorization: `Bearer ${this.#apiKey}` };

    const connection = new HostConnection(
      new WebSocket(this.#endpoint, {
        headers,
        followRedirects: true,
      }),
      { id }
    );

    connection.onClose.attach(async ([code, reason]) => {
      console.error(`Could not connect to trigger.dev (code ${code})`);

      if (reason) {
        console.error(reason);
      }
    });

    await connection.connect();

    this.#logger.debug("Connection initialized", id);

    this.#connection = connection;
    this.#isConnected = true;
  }

  async #initializeRPC() {
    if (!this.#connection) {
      throw new Error("Cannot initialize RPC without a connection");
    }

    const serverRPC = new ZodRPC({
      connection: this.#connection,
      sender: ServerRPCSchema,
      receiver: HostRPCSchema,
      handlers: {
        RESOLVE_DELAY: async (data) => {
          console.log(`RESOLVE_DELAY(${data.id})`);

          const waitCallbacks = this.#waitForCallbacks.get(data.id);

          if (!waitCallbacks) {
            throw new Error(
              `Could not find wait callbacks for wait ID ${data.id}`
            );
          }

          const { resolve, reject } = waitCallbacks;

          resolve();

          return true;
        },
        RESOLVE_REQUEST: async (data) => {
          const requestCallbacks = this.#responseCompleteCallbacks.get(data.id);

          if (!requestCallbacks) {
            throw new Error(
              `Could not find request callbacks for request ID ${data.id}`
            );
          }

          const { resolve, reject } = requestCallbacks;

          resolve(data.output);

          return true;
        },
        TRIGGER_WORKFLOW: async (data) => {
          console.log("TRIGGER_WORKFLOW", data);

          const ctx: TriggerContext = {
            id: data.id,
            environment: data.meta.environment,
            apiKey: data.meta.apiKey,
            organizationId: data.meta.organizationId,
            logger: new ContextLogger(async (level, message, properties) => {
              await serverRPC.send("SEND_LOG", {
                id: data.id,
                log: {
                  level,
                  message,
                  properties: JSON.stringify(properties ?? {}),
                },
              });
            }),
            fireEvent: async (event) => {
              await serverRPC.send("SEND_EVENT", {
                id: data.id,
                event: JSON.parse(JSON.stringify(event)),
              });
            },
            waitFor: async (options: WaitForOptions) => {
              const waitId = ulid();

              const result = new Promise<void>((resolve, reject) => {
                this.#waitForCallbacks.set(waitId, {
                  resolve,
                  reject,
                });
              });

              await serverRPC.send("INITIALIZE_DELAY", {
                id: data.id,
                waitId,
                config: {
                  type: "DELAY",
                  seconds: options.seconds,
                  minutes: options.minutes,
                  hours: options.hours,
                  days: options.days,
                },
              });

              await result;

              return;
            },
            waitUntil: async (date: Date) => {
              const waitId = ulid();

              const result = new Promise<void>((resolve, reject) => {
                this.#waitForCallbacks.set(waitId, {
                  resolve,
                  reject,
                });
              });

              await serverRPC.send("INITIALIZE_DELAY", {
                id: data.id,
                waitId,
                config: {
                  type: "SCHEDULE_FOR",
                  scheduledFor: date.toISOString(),
                },
              });

              await result;

              return;
            },
          };

          const eventData = this.#options.on.schema.parse(data.trigger.input);

          triggerRunLocalStorage.run(
            {
              performRequest: async (options) => {
                const requestId = ulid();

                const result = new Promise((resolve, reject) => {
                  this.#responseCompleteCallbacks.set(requestId, {
                    resolve,
                    reject,
                  });
                });

                await serverRPC.send("SEND_REQUEST", {
                  id: data.id,
                  requestId,
                  service: options.service,
                  endpoint: options.endpoint,
                  params: options.params,
                });

                const output = await result;

                return options.response.schema.parse(output);
              },
            },
            () => {
              // TODO: handle this better
              this.#trigger.options
                .run(eventData, ctx)
                .then((output) => {
                  return serverRPC.send("COMPLETE_WORKFLOW_RUN", {
                    id: data.id,
                    output: JSON.stringify(output),
                    workflowId: data.meta.workflowId,
                  });
                })
                .catch((anyError) => {
                  const parseAnyError = (
                    error: any
                  ): {
                    name: string;
                    message: string;
                    stackTrace?: string;
                  } => {
                    if (error instanceof Error) {
                      return {
                        name: error.name,
                        message: error.message,
                        stackTrace: error.stack,
                      };
                    }

                    return {
                      name: "UnknownError",
                      message: "An unknown error occurred",
                    };
                  };

                  const error = parseAnyError(anyError);

                  return serverRPC.send("SEND_WORKFLOW_ERROR", {
                    id: data.id,
                    workflowId: data.meta.workflowId,
                    error,
                  });
                });
            }
          );
        },
      },
    });

    this.#serverRPC = serverRPC;
  }

  async #initializeHost() {
    if (!this.#connection) {
      throw new Error("Cannot initialize host without a connection");
    }

    if (!this.#serverRPC) {
      throw new Error("Cannot initialize host without an RPC connection");
    }

    const response = await this.#send("INITIALIZE_HOST", {
      apiKey: this.#apiKey,
      workflowId: this.#trigger.id,
      workflowName: this.#trigger.name,
      trigger: this.#trigger.on.metadata,
      packageVersion: pkg.version,
      packageName: pkg.name,
    });

    if (response?.type === "error") {
      throw new Error(response.message);
    }

    console.log("Host initialized");
  }

  async #send<MethodName extends keyof typeof ServerRPCSchema>(
    methodName: MethodName,
    request: z.input<typeof ServerRPCSchema[MethodName]["request"]>
  ) {
    if (!this.#serverRPC) throw new Error("serverRPC not initialized");

    while (true) {
      try {
        return await this.#serverRPC.send(methodName, request);
      } catch (err) {
        if (err instanceof TimeoutError) {
          console.log(
            `RPC call timed out, retrying in ${Math.round(
              this.#retryIntervalMs / 1000
            )}s...`
          );
          console.log(err);

          await sleep(this.#retryIntervalMs);
        } else {
          throw err;
        }
      }
    }
  }
}

export const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

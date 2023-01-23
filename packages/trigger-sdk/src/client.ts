import { FetchOutput } from "@trigger.dev/common-schemas";
import {
  HostRPCSchema,
  Logger,
  ServerRPCSchema,
  ZodRPC,
} from "internal-bridge";
import { v4 } from "uuid";
import { WebSocket } from "ws";
import { z } from "zod";
import * as pkg from "../package.json";
import { HostConnection, TimeoutError } from "./connection";
import { triggerRunLocalStorage } from "./localStorage";
import { ContextLogger } from "./logger";
import { Trigger, TriggerOptions } from "./trigger";
import { TriggerContext, TriggerFetch } from "./types";

export class TriggerClient<TSchema extends z.ZodTypeAny> {
  #trigger: Trigger<TSchema>;
  #options: TriggerOptions<TSchema>;

  #connection?: HostConnection;
  #serverRPC?: ZodRPC<typeof ServerRPCSchema, typeof HostRPCSchema>;

  #apiKey: string;
  #endpoint: string;

  #isConnected = false;
  #retryIntervalMs: number = 3_000;
  #logger: Logger;
  #closedByUser = false;

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

  #fetchCallbacks = new Map<
    string,
    {
      resolve: (output: FetchOutput) => void;
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
    this.#endpoint = this.#options.endpoint ?? "wss://wss.trigger.dev/ws";
    this.#logger = new Logger("trigger.dev", this.#options.logLevel);
  }

  async listen(instanceId?: string) {
    await this.#initializeConnection(instanceId);
    this.#initializeRPC();
    this.#initializeHost();
  }

  close() {
    this.#closedByUser = true;

    if (this.#serverRPC) {
      this.#serverRPC = undefined;
    }

    this.#connection?.close();
    this.#isConnected = false;
  }

  async #initializeConnection(instanceId?: string) {
    const id = instanceId ?? v4();

    this.#logger.debug("Initializing connection", {
      id,
      endpoint: this.#endpoint,
    });

    const headers = { Authorization: `Bearer ${this.#apiKey}` };

    const connection = new HostConnection(
      new WebSocket(this.#endpoint, {
        headers,
        followRedirects: true,
      }),
      { id }
    );

    connection.onClose.attach(async ([code, reason]) => {
      if (this.#closedByUser) {
        this.#logger.debug("Connection closed by user, so we won't reconnect");
        this.#closedByUser = false;
        return;
      }

      this.#logger.error(`🚩 Could not connect to trigger.dev (code ${code})`);

      if (reason) {
        this.#logger.error("Reason:", reason);
      }

      // If #isConnected is already false, that means we are already trying to reconnect
      if (!this.#isConnected) return;

      this.#logger.log("🔌 Reconnecting to trigger.dev...");

      this.#isConnected = false;

      while (!this.#isConnected) {
        this.#initializeConnection(id)
          .then(() => {
            this.#logger.log("⚡ Reconnection successful");
          })
          .catch(() => {});

        this.#logger.debug(
          `Reconnection failed, retrying in ${Math.round(
            this.#retryIntervalMs / 1000
          )} seconds`,
          id
        );

        await new Promise((resolve) =>
          setTimeout(resolve, this.#retryIntervalMs)
        );
      }
    });

    await connection.connect();

    this.#logger.debug("Connection initialized", id);

    this.#connection = connection;
    this.#isConnected = true;

    if (this.#serverRPC) {
      this.#serverRPC.resetConnection(connection);
      await this.#initializeHost();
    }
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
          this.#logger.debug("Handling RESOLVE_DELAY", data);

          const waitCallbacks = this.#waitForCallbacks.get(
            messageKey(data.meta.runId, data.key)
          );

          if (!waitCallbacks) {
            this.#logger.debug(
              `Could not find wait callbacks for wait ID ${messageKey(
                data.meta.runId,
                data.key
              )}. This can happen when a workflow run is resumed`
            );

            return true;
          }

          const { resolve } = waitCallbacks;

          resolve();

          return true;
        },
        RESOLVE_REQUEST: async (data) => {
          this.#logger.debug("Handling RESOLVE_REQUEST", data);

          const requestCallbacks = this.#responseCompleteCallbacks.get(
            messageKey(data.meta.runId, data.key)
          );

          if (!requestCallbacks) {
            this.#logger.debug(
              `Could not find request callbacks for request ID ${messageKey(
                data.meta.runId,
                data.key
              )}. This can happen when a workflow run is resumed`
            );

            return true;
          }

          const { resolve } = requestCallbacks;

          resolve(data.output);

          return true;
        },
        REJECT_REQUEST: async (data) => {
          this.#logger.debug("Handling REJECT_REQUEST", data);

          const requestCallbacks = this.#responseCompleteCallbacks.get(
            messageKey(data.meta.runId, data.key)
          );

          if (!requestCallbacks) {
            this.#logger.debug(
              `Could not find request callbacks for request ID ${messageKey(
                data.meta.runId,
                data.key
              )}. This can happen when a workflow run is resumed`
            );

            return true;
          }

          const { reject } = requestCallbacks;

          reject(data.error);

          return true;
        },
        RESOLVE_FETCH_REQUEST: async (data) => {
          this.#logger.debug("Handling RESOLVE_FETCH_REQUEST", data);

          const fetchCallbacks = this.#fetchCallbacks.get(
            messageKey(data.meta.runId, data.key)
          );

          if (!fetchCallbacks) {
            this.#logger.debug(
              `Could not find fetch callbacks for request ID ${messageKey(
                data.meta.runId,
                data.key
              )}. This can happen when a workflow run is resumed`
            );

            return true;
          }

          const { resolve } = fetchCallbacks;

          resolve(data.output);

          return true;
        },
        REJECT_FETCH_REQUEST: async (data) => {
          this.#logger.debug("Handling REJECT_FETCH_REQUEST", data);

          const fetchCallbacks = this.#fetchCallbacks.get(
            messageKey(data.meta.runId, data.key)
          );

          if (!fetchCallbacks) {
            this.#logger.debug(
              `Could not find fetch callbacks for request ID ${messageKey(
                data.meta.runId,
                data.key
              )}. This can happen when a workflow run is resumed`
            );

            return true;
          }

          const { reject } = fetchCallbacks;

          reject(data.error);

          return true;
        },
        TRIGGER_WORKFLOW: async (data) => {
          this.#logger.debug("Handling TRIGGER_WORKFLOW", data);

          const fetchFunction: TriggerFetch = async (key, url, options) => {
            const result = new Promise<FetchOutput>((resolve, reject) => {
              this.#fetchCallbacks.set(messageKey(data.id, key), {
                resolve,
                reject,
              });
            });

            await serverRPC.send("SEND_FETCH", {
              runId: data.id,
              key,
              fetch: {
                url: url.toString(),
                method: options.method ?? "GET",
                headers: options.headers,
                body: options.body,
              },
              timestamp: String(highPrecisionTimestamp()),
            });

            const response = await result;

            return {
              status: response.status,
              ok: response.ok,
              headers: response.headers,
              body: response.body
                ? (options.responseSchema ?? z.any()).parse(response.body)
                : undefined,
            };
          };

          const ctx: TriggerContext = {
            id: data.id,
            environment: data.meta.environment,
            apiKey: data.meta.apiKey,
            organizationId: data.meta.organizationId,
            logger: new ContextLogger(async (level, message, properties) => {
              await serverRPC.send("SEND_LOG", {
                runId: data.id,
                key: message,
                log: {
                  level,
                  message,
                  properties: JSON.stringify(properties ?? {}),
                },
                timestamp: String(highPrecisionTimestamp()),
              });
            }),
            sendEvent: async (key, event) => {
              await serverRPC.send("SEND_EVENT", {
                runId: data.id,
                key,
                event: JSON.parse(JSON.stringify(event)),
                timestamp: String(highPrecisionTimestamp()),
              });
            },
            waitFor: async (key, options) => {
              const result = new Promise<void>((resolve, reject) => {
                this.#waitForCallbacks.set(messageKey(data.id, key), {
                  resolve,
                  reject,
                });
              });

              await serverRPC.send("INITIALIZE_DELAY", {
                runId: data.id,
                key,
                wait: {
                  type: "DELAY",
                  seconds: options.seconds,
                  minutes: options.minutes,
                  hours: options.hours,
                  days: options.days,
                },
                timestamp: String(highPrecisionTimestamp()),
              });

              await result;

              return;
            },
            waitUntil: async (key, date: Date) => {
              const result = new Promise<void>((resolve, reject) => {
                this.#waitForCallbacks.set(messageKey(data.id, key), {
                  resolve,
                  reject,
                });
              });

              await serverRPC.send("INITIALIZE_DELAY", {
                runId: data.id,
                key,
                wait: {
                  type: "SCHEDULE_FOR",
                  scheduledFor: date.toISOString(),
                },
                timestamp: String(highPrecisionTimestamp()),
              });

              await result;

              return;
            },
            fetch: fetchFunction,
          };

          const eventData = this.#options.on.schema.parse(data.trigger.input);

          this.#logger.debug("Parsed event data", eventData);

          triggerRunLocalStorage.run(
            {
              performRequest: async (key, options) => {
                const result = new Promise((resolve, reject) => {
                  this.#responseCompleteCallbacks.set(
                    messageKey(data.id, key),
                    {
                      resolve,
                      reject,
                    }
                  );
                });

                await serverRPC.send("SEND_REQUEST", {
                  runId: data.id,
                  key,
                  request: {
                    service: options.service,
                    endpoint: options.endpoint,
                    params: options.params,
                  },
                  timestamp: String(highPrecisionTimestamp()),
                });

                const output = await result;

                return options.response.schema.parse(output);
              },
              sendEvent: async (key, event) => {
                await serverRPC.send("SEND_EVENT", {
                  runId: data.id,
                  key,
                  event: JSON.parse(JSON.stringify(event)),
                  timestamp: String(highPrecisionTimestamp()),
                });
              },
              fetch: fetchFunction,
            },
            () => {
              this.#logger.debug("Running trigger...");

              serverRPC
                .send("START_WORKFLOW_RUN", {
                  runId: data.id,
                  timestamp: String(highPrecisionTimestamp()),
                })
                .then(() => {
                  return this.#trigger.options
                    .run(eventData, ctx)
                    .then((output) => {
                      this.#logger.log(
                        `Completed workflow '${this.#options.name}', run ${
                          data.id
                        } 🏃`
                      );

                      return serverRPC.send("COMPLETE_WORKFLOW_RUN", {
                        runId: data.id,
                        output: JSON.stringify(output),
                        timestamp: String(highPrecisionTimestamp()),
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

                        console.error(anyError);

                        return {
                          name: "UnknownError",
                          message: "An unknown error occurred",
                        };
                      };

                      const error = parseAnyError(anyError);

                      return serverRPC.send("SEND_WORKFLOW_ERROR", {
                        runId: data.id,
                        error,
                        timestamp: String(highPrecisionTimestamp()),
                      });
                    });
                })
                .catch((anyError) => {
                  return serverRPC.send("SEND_WORKFLOW_ERROR", {
                    runId: data.id,
                    error: anyError,
                    timestamp: String(highPrecisionTimestamp()),
                  });
                });
            }
          );

          return true;
        },
      },
    });

    this.#logger.debug("Successfully initialized RPC with server");

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
      triggerTTL: this.#options.triggerTTL,
    });

    if (response?.type === "error") {
      throw new Error(response.message);
    }

    this.#logger.debug("Successfully initialized workflow with server");
  }

  async #send<MethodName extends keyof typeof ServerRPCSchema>(
    methodName: MethodName,
    request: z.input<(typeof ServerRPCSchema)[MethodName]["request"]>
  ) {
    if (!this.#serverRPC) throw new Error("serverRPC not initialized");

    while (true) {
      try {
        this.#logger.debug(
          `Sending RPC request to server: ${methodName}`,
          request
        );

        return await this.#serverRPC.send(methodName, request);
      } catch (err) {
        if (err instanceof TimeoutError) {
          this.#logger.log(
            `RPC call timed out, retrying in ${Math.round(
              this.#retryIntervalMs / 1000
            )}s...`
          );

          this.#logger.error(err);

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

const messageKey = (runId: string, key: string) => `${runId}:${key}`;

function highPrecisionTimestamp() {
  const [seconds, nanoseconds] = process.hrtime();

  return seconds * 1e9 + nanoseconds;
}

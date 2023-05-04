import {
  ErrorWithMessage,
  ErrorWithStackSchema,
  LogLevel,
  Logger,
  NormalizedRequest,
  NormalizedResponse,
  RegisterHttpEventSourceBody,
  RunJobBody,
  RunJobBodySchema,
  UpdateHttpEventSourceBody,
} from "@trigger.dev/internal";
import { ApiClient } from "./apiClient";
import {
  AuthenticatedTask,
  Connection,
  IOWithConnections,
} from "./connections";
import { IO, ResumeWithTask } from "./io";
import { Job } from "./job";
import { ContextLogger } from "./logger";
import type { Trigger, TriggerContext } from "./types";

export type TriggerClientOptions = {
  apiKey?: string;
  apiUrl?: string;
  endpoint?: string;
  path?: string;
  logLevel?: LogLevel;
};

export type ListenOptions = {
  url: string;
};

export class TriggerClient {
  #options: TriggerClientOptions;
  #registeredJobs: Record<string, Job<Trigger<any>, any>> = {};
  #registeredTriggerVariants: Record<
    string,
    Array<{ trigger: Trigger<any>; id: string }>
  > = {};
  #client: ApiClient;
  #logger: Logger;
  name: string;
  endpoint: string;

  constructor(name: string, options: TriggerClientOptions) {
    this.name = name;
    this.endpoint = options.endpoint ?? buildEndpointUrl(options.path);
    this.#options = options;
    this.#client = new ApiClient(this.#options);
    this.#logger = new Logger("trigger.dev", this.#options.logLevel);
  }

  async handleRequest(request: NormalizedRequest): Promise<NormalizedResponse> {
    this.#logger.debug("handling request", { request });

    const apiKey = request.headers["x-trigger-api-key"];

    if (!this.authorized(apiKey)) {
      return {
        status: 401,
        body: {
          message: "Unauthorized",
        },
      };
    }

    if (request.method === "GET") {
      const action = request.headers["x-trigger-action"];

      if (action === "PING") {
        return {
          status: 200,
          body: {
            message: "PONG",
          },
        };
      }

      // if the x-trigger-job-id header is set, we return the job with that id
      if (request.headers["x-trigger-job-id"]) {
        const job = this.#registeredJobs[request.headers["x-trigger-job-id"]];

        if (!job) {
          return {
            status: 404,
            body: {
              message: "Job not found",
            },
          };
        }

        const triggerVariants = this.#registeredTriggerVariants[job.id] ?? [];

        return {
          status: 200,
          body: {
            metadata: job.toJSON(),
            triggerVariants: triggerVariants.map(({ trigger, id }) => ({
              id,
              trigger: trigger.toJSON(),
            })),
          },
        };
      }

      // if the x-trigger-job-id header is not set, we return all jobs
      return {
        status: 200,
        body: {
          jobs: Object.values(this.#registeredJobs).map((job) => ({
            metadata: job.toJSON(),
            triggerVariants: (
              this.#registeredTriggerVariants[job.id] ?? []
            ).map(({ id, trigger }) => ({ id, trigger: trigger.toJSON() })),
          })),
        },
      };
    }

    if (request.method === "POST") {
      // Get the action from the headers
      const action = request.headers["x-trigger-action"];

      switch (action) {
        case "INITIALIZE": {
          await this.listen();

          return {
            status: 200,
            body: {
              message: "Initialized",
            },
          };
        }
        case "EXECUTE_JOB": {
          const execution = RunJobBodySchema.safeParse(request.body);

          if (!execution.success) {
            return {
              status: 400,
              body: {
                message: "Invalid execution",
              },
            };
          }

          const job = this.#registeredJobs[execution.data.job.id];

          if (!job) {
            return {
              status: 404,
              body: {
                message: "Job not found",
              },
            };
          }

          const results = await this.#executeJob(execution.data, job);

          if (results.error) {
            return {
              status: 500,
              body: results.error,
            };
          }

          return {
            status: 200,
            body: {
              completed: results.completed,
              output: results.output,
              executionId: execution.data.context.id,
              task: results.task,
            },
          };
        }
      }
    }

    return {
      status: 405,
      body: {
        message: "Method not allowed",
      },
    };
  }

  attach(job: Job<Trigger<any>, any>): void {
    this.#registeredJobs[job.id] = job;

    job.trigger.attach(this, job);
  }

  attachVariant<TTrigger extends Trigger<any>>(
    job: Job<TTrigger, any>,
    id: string,
    trigger: TTrigger
  ) {
    const jobTriggerVariants = this.#registeredTriggerVariants[job.id] ?? [];
    jobTriggerVariants.push({ trigger, id });
    this.#registeredTriggerVariants[job.id] = jobTriggerVariants;

    trigger.attach(this, job, id);
  }

  authorized(apiKey: string) {
    const localApiKey = this.#options.apiKey ?? process.env.TRIGGER_API_KEY;

    if (!localApiKey) {
      return false;
    }

    return apiKey === localApiKey;
  }

  apiKey() {
    return this.#options.apiKey ?? process.env.TRIGGER_API_KEY;
  }

  async listen() {
    // Register the endpoint
    await this.#client.registerEndpoint({
      url: this.endpoint,
      name: this.name,
    });
  }

  async registerHttpSource(source: RegisterHttpEventSourceBody) {
    return await this.#client.registerHttpSource(this.name, source);
  }

  async updateHttpSource(id: string, source: UpdateHttpEventSourceBody) {
    return await this.#client.updateHttpSource(this.name, id, source);
  }

  async #executeJob(execution: RunJobBody, job: Job<Trigger<any>, any>) {
    this.#logger.debug("executing job", { execution, job: job.toJSON() });

    const abortController = new AbortController();

    const io = new IO({
      id: execution.context.id,
      cachedTasks: execution.tasks,
      apiClient: this.#client,
      logger: this.#logger,
      client: this,
    });

    const ioWithConnections = this.#createIOWithConnections(io, execution, job);

    try {
      const output = await job.options.run(
        job.trigger.parsePayload(execution.event.payload ?? {}),
        ioWithConnections,
        this.#createJobContext(execution, io, abortController.signal)
      );

      return { completed: true, output };
    } catch (error) {
      if (error instanceof ResumeWithTask) {
        return { completed: false, task: error.task };
      }

      const errorWithStack = ErrorWithStackSchema.safeParse(error);

      if (errorWithStack.success) {
        return { completed: true, error: errorWithStack.data };
      }

      const errorWithMessage = ErrorWithMessage.safeParse(error);

      if (errorWithMessage.success) {
        return { completed: true, error: errorWithMessage.data };
      }

      return {
        completed: true,
        error: { message: "Unknown error" },
      };
    }
  }

  #createIOWithConnections<
    TConnections extends Record<string, Connection<any, any>>
  >(
    io: IO,
    run: RunJobBody,
    job: Job<Trigger<any>, TConnections>
  ): IOWithConnections<TConnections> {
    const jobConnections = job.options.connections;

    if (!jobConnections) {
      return io as IOWithConnections<TConnections>;
    }

    const runConnections = run.connections ?? {};

    const connections = Object.entries(jobConnections).reduce(
      (acc, [key, jobConnection]) => {
        const connection = runConnections[key];
        const client =
          jobConnection.client ?? jobConnection.clientFactory?.(connection);

        if (!client) {
          return acc;
        }

        const ioConnection = {
          client,
        } as any;

        if (jobConnection.tasks) {
          const tasks: Record<
            string,
            AuthenticatedTask<any, any, any>
          > = jobConnection.tasks;

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
        if (prop in connections) {
          return connections[prop];
        }

        const value = Reflect.get(target, prop, receiver);
        return typeof value == "function" ? value.bind(target) : value;
      },
    }) as IOWithConnections<TConnections>;
  }

  #createJobContext(
    execution: RunJobBody,
    io: IO,
    signal: AbortSignal
  ): TriggerContext {
    return {
      ...execution.context,
      signal,
      logger: new ContextLogger(async (level, message, data) => {
        switch (level) {
          case "DEBUG": {
            this.#logger.debug(message, data);
            break;
          }
          case "INFO": {
            this.#logger.info(message, data);
            break;
          }
          case "WARN": {
            this.#logger.warn(message, data);
            break;
          }
          case "ERROR": {
            this.#logger.error(message, data);
            break;
          }
        }

        await io.runTask(
          [message, level],
          {
            name: "log",
            icon: "log",
            description: message,
            params: data,
            elements: [{ label: "Level", text: level }],
            noop: true,
          },
          async (task) => {}
        );
      }),
      wait: async (id, seconds) => {
        await io.runTask(
          id,
          {
            name: "wait",
            icon: "clock",
            params: { seconds },
            noop: true,
            delayUntil: new Date(Date.now() + seconds * 1000),
          },
          async (task) => {}
        );
      },
      sendEvent: async (key, event, options) => {
        return await io.runTask(
          key,
          {
            name: "sendEvent",
            params: { event, options },
          },
          async (task) => {
            return await this.#client.sendEvent(event, options);
          }
        );
      },
    };
  }
}

function buildEndpointUrl(path?: string): string {
  // Try to get the endpoint from the environment
  const endpoint = process.env.TRIGGER_ENDPOINT;

  // If the endpoint is set, we return it + the path
  if (endpoint) {
    return endpoint + (path ?? "");
  }

  // Try and get the host from the environment
  const host =
    process.env.TRIGGER_HOST ??
    process.env.HOST ??
    process.env.HOSTNAME ??
    process.env.NOW_URL ??
    process.env.VERCEL_URL;

  // If the host is set, we return it + the path
  if (host) {
    return "https://" + host + (path ?? "");
  }

  // If we can't get the host, we throw an error
  throw new Error(
    "Could not determine the endpoint for the trigger client. Please set the TRIGGER_ENDPOINT environment variable."
  );
}

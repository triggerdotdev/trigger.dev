import {
  ApiEventLog,
  ApiEventLogSchema,
  ConnectionAuth,
  ErrorWithMessage,
  ErrorWithStackSchema,
  ExecuteJobBody,
  ExecuteJobBodySchema,
  HttpSourceRequest,
  HttpSourceRequestHeadersSchema,
  Logger,
  LogLevel,
  NormalizedRequest,
  NormalizedResponse,
  PrepareForJobExecutionBodySchema,
  RegisterHttpEventSourceBody,
  SendEvent,
  UpdateHttpEventSourceBody,
} from "@trigger.dev/internal";
import { ApiClient } from "./apiClient";
import {
  AuthenticatedTask,
  Connection,
  IOWithConnections,
} from "./connections";
import { AnyExternalSource } from "./externalSource";
import { IO, ResumeWithTask } from "./io";
import { Job } from "./job";
import { ContextLogger } from "./logger";
import { TriggerContext } from "./types";

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
  #registeredJobs: Record<string, Job<{}, any>> = {};
  #registeredSources = new Map<string, AnyExternalSource>();
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

        return {
          status: 200,
          body: job.toJSON(),
        };
      }

      // if the x-trigger-job-id header is not set, we return all jobs
      return {
        status: 200,
        body: {
          jobs: Object.values(this.#registeredJobs).map((job) => job.toJSON()),
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
        case "DELIVER_EVENT": {
          const eventLog = ApiEventLogSchema.safeParse(request.body);

          if (!eventLog.success) {
            return {
              status: 400,
              body: {
                message: "Invalid event log",
              },
            };
          }

          await this.#dispatchEventToJobs(eventLog.data);

          return {
            status: 200,
            body: {
              deliveredAt: new Date().toISOString(),
            },
          };
        }
        case "EXECUTE_JOB": {
          const execution = ExecuteJobBodySchema.safeParse(request.body);

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
        case "PREPARE_FOR_JOB_EXECUTION": {
          const payload = PrepareForJobExecutionBodySchema.safeParse(
            request.body
          );

          if (!payload.success) {
            return {
              status: 400,
              body: {
                message: "Invalid payload",
              },
            };
          }

          const registeredJob = this.#registeredJobs[payload.data.id];

          if (!registeredJob) {
            return {
              status: 404,
              body: {
                message: "Job not found",
              },
            };
          }

          await this.#prepareJobForExecution(registeredJob, payload.data);

          return {
            status: 200,
            body: {
              ok: true,
            },
          };
        }
        case "DELIVER_HTTP_SOURCE_REQUEST": {
          const headers = HttpSourceRequestHeadersSchema.safeParse(
            request.headers
          );

          if (!headers.success) {
            return {
              status: 400,
              body: {
                message: "Invalid headers",
              },
            };
          }

          const sourceRequest = {
            url: headers.data["x-trigger-url"],
            method: headers.data["x-trigger-method"],
            headers: headers.data["x-trigger-headers"],
            body: request.body,
          };

          const auth = headers.data["x-trigger-auth"];
          const key = headers.data["x-trigger-key"];
          const secret = headers.data["x-trigger-secret"];

          const { response, events } = await this.#handleHttpSourceRequest(
            key,
            sourceRequest,
            secret,
            auth
          );

          return {
            status: 200,
            body: {
              events,
              response,
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

  register(thing: AnyExternalSource): void;
  register(thing: Job<{}, any>): void;
  register(thing: Job<{}, any> | AnyExternalSource): void {
    if (thing instanceof Job) {
      this.#registeredJobs[thing.id] = thing;

      thing.trigger.registerWith(this);
    } else {
      this.#registeredSources.set(thing.key, thing);
    }
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

  async #prepareJobForExecution(
    job: Job<{}, any>,
    preparationData: {
      id: string;
      version: string;
      connections: Record<string, ConnectionAuth>;
    }
  ): Promise<void> {
    this.#logger.debug("preparing job for execution", { job: job.toJSON() });

    if (job.version !== preparationData.version) {
      return;
    }

    await job.prepareForExecution(this, preparationData.connections);
  }

  async #handleHttpSourceRequest(
    key: string,
    sourceRequest: HttpSourceRequest,
    secret?: string,
    auth?: ConnectionAuth
  ): Promise<{ response: NormalizedResponse; events: SendEvent[] }> {
    const source = this.#registeredSources.get(key);

    if (!source) {
      return {
        response: {
          status: 200,
          body: {
            ok: true,
          },
        },
        events: [],
      };
    }

    return await source.handler(this, { request: sourceRequest, secret }, auth);
  }

  async #dispatchEventToJobs(event: ApiEventLog) {
    this.#logger.debug("dispatching event to jobs", { event });

    // For each job, we check if the event matches the job's trigger
    const matchingJobs = Object.values(this.#registeredJobs).filter((job) =>
      job.trigger.matches(event)
    );

    // For each matching job, we need to create a new job execution with the event, and then run the job
    const executions = await Promise.all(
      matchingJobs.map((job) => this.#createExecution(job, event))
    );

    return executions;
  }

  async #createExecution(job: Job<{}, any>, event: ApiEventLog) {
    this.#logger.debug("creating execution", { event, job: job.toJSON() });

    // Create a new job execution
    const execution = await this.#client.createExecution({
      client: this.name,
      job: job.toJSON(),
      event,
      elements: job.trigger.eventElements(event),
    });

    return execution;
  }

  async #executeJob(execution: ExecuteJobBody, job: Job<{}, any>) {
    this.#logger.debug("executing job", { execution, job: job.toJSON() });

    const abortController = new AbortController();

    const io = new IO({
      id: execution.context.id,
      cachedTasks: execution.tasks,
      apiClient: this.#client,
      logger: this.#logger,
    });

    const ioWithConnections = await this.#createIOWithConnections(
      io,
      execution,
      job
    );

    try {
      const output = await job.options.run(
        execution.event.payload ?? {},
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
    TConnections extends Record<string, Connection<any, any, any>>
  >(
    io: IO,
    execution: ExecuteJobBody,
    job: Job<{}, TConnections>
  ): IOWithConnections<TConnections> {
    const jobConnections = job.options.connections;

    if (!jobConnections) {
      return io as IOWithConnections<TConnections>;
    }

    const executionConnections = execution.connections ?? {};

    const connections = Object.entries(jobConnections).reduce(
      (acc, [key, jobConnection]) => {
        const connection = executionConnections[key];
        const client = jobConnection.clientFactory(connection);

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
                  return authenticatedTask.run(params, client, ioTask);
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
    execution: ExecuteJobBody,
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

import {
  ApiEventLogSchema,
  ErrorWithMessage,
  ErrorWithStackSchema,
  ExecuteJobBody,
  ExecuteJobBodySchema,
  Logger,
} from "@trigger.dev/internal";
import { ApiClient } from "./apiClient";
import { Job } from "./job";
import type { LogLevel, ApiEventLog } from "@trigger.dev/internal";
import { TriggerContext } from "./types";
import { ContextLogger } from "./logger";
import { IO, ResumeWithTask } from "./io";

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

export type NormalizedRequest = {
  headers: Record<string, string>;
  method: string;
  query: Record<string, string>;
  url: string;
  body: any;
};

export class TriggerClient {
  #options: TriggerClientOptions;
  #registeredJobs: Record<string, Job> = {};
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

  async handleRequest(request: NormalizedRequest) {
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
      }
    }
  }

  register(job: Job) {
    this.#registeredJobs[job.id] = job;
  }

  authorized(apiKey: string) {
    return apiKey === this.#options.apiKey;
  }

  async listen() {
    // Register the endpoint
    await this.#client.registerEndpoint({
      url: this.endpoint,
      name: this.name,
    });
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

  async #createExecution(job: Job, event: ApiEventLog) {
    this.#logger.debug("creating execution", { event, job: job.toJSON() });

    // Create a new job execution
    const execution = await this.#client.createExecution({
      client: this.name,
      job: job.toJSON(),
      event,
    });

    return execution;
  }

  async #executeJob(execution: ExecuteJobBody, job: Job) {
    this.#logger.debug("executing job", { execution, job: job.toJSON() });

    const abortController = new AbortController();

    const io = new IO({
      id: execution.context.id,
      cachedTasks: execution.tasks,
      apiClient: this.#client,
      logger: this.#logger,
    });

    try {
      const output = await job.options.run(
        execution.event.payload,
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
            description: message,
            params: data,
            displayProperties: [{ label: "Level", value: level }],
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

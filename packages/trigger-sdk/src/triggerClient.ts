import {
  ErrorWithMessage,
  ErrorWithStackSchema,
  GetEndpointDataResponse,
  HandleTriggerSource,
  HttpSourceRequest,
  HttpSourceRequestHeadersSchema,
  LogLevel,
  Logger,
  NormalizedRequest,
  NormalizedResponse,
  RegisterSourceEvent,
  RegisterSourceEventSchema,
  RegisterTriggerBody,
  RunJobBody,
  RunJobBodySchema,
  SendEvent,
  SourceMetadata,
} from "@trigger.dev/internal";
import { ApiClient } from "./apiClient";
import { IO, ResumeWithTask } from "./io";
import { createIOWithIntegrations } from "./ioWithIntegrations";
import { Job } from "./job";
import { CustomTrigger } from "./triggers/customTrigger";
import { ExternalSource, HttpSourceEvent } from "./triggers/externalSource";
import type { EventSpecification, Trigger, TriggerContext } from "./types";
import { DynamicTrigger } from "./triggers/dynamic";

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
  #registeredJobs: Record<string, Job<Trigger<EventSpecification<any>>, any>> =
    {};
  #registeredSources: Record<string, SourceMetadata> = {};
  #registeredHttpSourceHandlers: Record<
    string,
    (
      source: HandleTriggerSource,
      request: HttpSourceEvent
    ) => Promise<{
      events: Array<SendEvent>;
      response?: NormalizedResponse;
    } | void>
  > = {};
  #registeredDynamicTriggers: Record<
    string,
    DynamicTrigger<EventSpecification<any>, ExternalSource<any, any, any>>
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

        return {
          status: 200,
          body: job.toJSON(),
        };
      }

      const body: GetEndpointDataResponse = {
        jobs: Object.values(this.#registeredJobs).map((job) => job.toJSON()),
        sources: Object.values(this.#registeredSources),
        dynamicTriggers: [],
      };

      // if the x-trigger-job-id header is not set, we return all jobs
      return {
        status: 200,
        body,
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
              executionId: execution.data.run.id,
              task: results.task,
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
            url: headers.data["x-ts-http-url"],
            method: headers.data["x-ts-http-method"],
            headers: headers.data["x-ts-http-headers"],
            rawBody: request.body,
          };

          const key = headers.data["x-ts-key"];
          const dynamicId = headers.data["x-ts-dynamic-id"];
          const secret = headers.data["x-ts-secret"];
          const params = headers.data["x-ts-params"];
          const data = headers.data["x-ts-data"];

          const source = {
            key,
            dynamicId,
            secret,
            params,
            data,
          };

          const { response, events } = await this.#handleHttpSourceRequest(
            source,
            sourceRequest
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

  attach(job: Job<Trigger<any>, any>): void {
    this.#registeredJobs[job.id] = job;

    job.trigger.attachToJob(this, job);
  }

  attachDynamicTrigger(trigger: DynamicTrigger<any, any>): void {
    this.#registeredDynamicTriggers[trigger.id] = trigger;
  }

  attachSource(options: {
    key: string;
    source: ExternalSource<any, any>;
    event: EventSpecification<any>;
    params: any;
  }): void {
    this.#registeredHttpSourceHandlers[options.key] = async (s, r) => {
      return await options.source.handle(s, r, this.#logger);
    };

    let registeredSource = this.#registeredSources[options.key];

    if (!registeredSource) {
      registeredSource = {
        channel: options.source.channel,
        key: options.key,
        params: options.params,
        events: [],
        clientId: !options.source.integration.usesLocalAuth
          ? options.source.integration.id
          : undefined,
      };
    }

    registeredSource.events = Array.from(
      new Set([...registeredSource.events, options.event.name])
    );

    this.#registeredSources[options.key] = registeredSource;

    const registerSourceEvent: EventSpecification<RegisterSourceEvent> = {
      name: "trigger.internal.registerSource",
      title: "Register Source",
      source: "internal",
      parsePayload: RegisterSourceEventSchema.parse,
    };

    new Job(this, {
      id: options.key,
      name: options.key,
      version: options.source.version,
      trigger: new CustomTrigger({
        event: registerSourceEvent,
        filter: { source: { key: [options.key] } },
      }),
      integrations: {
        integration: options.source.integration,
      },
      queue: {
        name: options.key,
        maxConcurrent: 1,
      },
      startPosition: "initial",
      run: async (event, io, ctx) => {
        const updates = await options.source.register(
          options.params,
          event,
          io,
          ctx
        );

        if (!updates) {
          // TODO: do something here?
          return;
        }

        return await io.updateSource("update-source", {
          key: options.key,
          ...updates,
        });
      },
      // @ts-ignore
      __internal: true,
    });
  }

  async registerTrigger(id: string, options: RegisterTriggerBody) {
    return this.#client.registerTrigger(this.name, id, options);
  }

  async getAuth(id: string) {
    return this.#client.getAuth(this.name, id);
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

  async #executeJob(execution: RunJobBody, job: Job<Trigger<any>, any>) {
    this.#logger.debug("executing job", { execution, job: job.toJSON() });

    const context = this.#createRunContext(execution);

    const io = new IO({
      id: execution.run.id,
      cachedTasks: execution.tasks,
      apiClient: this.#client,
      logger: this.#logger,
      client: this,
      context,
    });

    const ioWithConnections = createIOWithIntegrations(
      io,
      execution.connections,
      job.options.integrations
    );

    try {
      const output = await job.options.run(
        job.trigger.event.parsePayload(execution.event.payload ?? {}),
        ioWithConnections,
        context
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

  #createRunContext(execution: RunJobBody): TriggerContext {
    const { event, organization, environment, job, run } = execution;

    return {
      event: {
        id: event.id,
        name: event.name,
        context: event.context,
        timestamp: event.timestamp,
      },
      organization,
      environment,
      job,
      run,
    };
  }

  async #handleHttpSourceRequest(
    source: {
      key: string;
      dynamicId?: string;
      secret: string;
      data: any;
      params: any;
    },
    sourceRequest: HttpSourceRequest
  ): Promise<{ response: NormalizedResponse; events: SendEvent[] }> {
    this.#logger.debug("Handling HTTP source request", {
      source,
    });

    if (source.dynamicId) {
      const dynamicTrigger = this.#registeredDynamicTriggers[source.dynamicId];

      if (!dynamicTrigger) {
        this.#logger.debug("No dynamic trigger registered for HTTP source", {
          source,
        });

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

      const results = await dynamicTrigger.source.handle(
        source,
        sourceRequest,
        this.#logger
      );

      if (!results) {
        return {
          events: [],
          response: {
            status: 200,
            body: {
              ok: true,
            },
          },
        };
      }

      return {
        events: results.events,
        response: results.response ?? {
          status: 200,
          body: {
            ok: true,
          },
        },
      };
    }

    const handler = this.#registeredHttpSourceHandlers[source.key];

    if (!handler) {
      this.#logger.debug("No handler registered for HTTP source", {
        source,
      });

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

    const results = await handler(source, sourceRequest);

    if (!results) {
      return {
        events: [],
        response: {
          status: 200,
          body: {
            ok: true,
          },
        },
      };
    }

    return {
      events: results.events,
      response: results.response ?? {
        status: 200,
        body: {
          ok: true,
        },
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

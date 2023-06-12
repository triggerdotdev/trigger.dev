import {
  ErrorWithStackSchema,
  GetEndpointDataResponse,
  HandleTriggerSource,
  HttpSourceRequestHeadersSchema,
  InitializeTriggerBodySchema,
  LogLevel,
  Logger,
  NormalizedResponse,
  PreprocessRunBody,
  PreprocessRunBodySchema,
  REGISTER_SOURCE_EVENT,
  RegisterSourceEvent,
  RegisterSourceEventSchema,
  RegisterTriggerBody,
  RunJobBody,
  RunJobBodySchema,
  RunJobResponse,
  ScheduleMetadata,
  SendEvent,
  SendEventOptions,
  SourceMetadata,
} from "@trigger.dev/internal";
import { ApiClient } from "./apiClient";
import { IO, ResumeWithTask, TaskError } from "./io";
import { createIOWithIntegrations } from "./ioWithIntegrations";
import { Job } from "./job";
import { DynamicTrigger } from "./triggers/dynamic";
import { EventTrigger } from "./triggers/eventTrigger";
import { ExternalSource } from "./triggers/externalSource";
import type {
  EventSpecification,
  Trigger,
  TriggerContext,
  TriggerPreprocessContext,
} from "./types";

const registerSourceEvent: EventSpecification<RegisterSourceEvent> = {
  name: REGISTER_SOURCE_EVENT,
  title: "Register Source",
  source: "internal",
  icon: "register-source",
  parsePayload: RegisterSourceEventSchema.parse,
};

export type TriggerClientOptions = {
  id: string;
  url?: string;
  apiKey?: string;
  apiUrl?: string;
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
      request: Request
    ) => Promise<{
      events: Array<SendEvent>;
      response?: NormalizedResponse;
    } | void>
  > = {};
  #registeredDynamicTriggers: Record<
    string,
    DynamicTrigger<EventSpecification<any>, ExternalSource<any, any, any>>
  > = {};
  #jobMetadataByDynamicTriggers: Record<
    string,
    Array<{ id: string; version: string }>
  > = {};
  #registeredSchedules: Record<string, Array<{ id: string; version: string }>> =
    {};

  #client: ApiClient;
  #logger: Logger;
  private _url: string;
  id: string;
  path?: string;

  constructor(options: TriggerClientOptions) {
    this.id = options.id;
    this._url = buildClientUrl(options.url);
    this.#options = options;
    this.#client = new ApiClient(this.#options);
    this.#logger = new Logger("trigger.dev", this.#options.logLevel);
  }

  get url() {
    return `${this._url}${
      this.path ? `${this.path.startsWith("/") ? "" : "/"}${this.path}` : ""
    }`;
  }

  async handleRequest(request: Request): Promise<NormalizedResponse> {
    this.#logger.debug("handling request", {
      url: request.url,
      headers: Object.fromEntries(request.headers.entries()),
      method: request.method,
    });

    const apiKey = request.headers.get("x-trigger-api-key");

    if (!this.authorized(apiKey)) {
      return {
        status: 401,
        body: {
          message: "Unauthorized",
        },
      };
    }

    if (request.method !== "POST") {
      return {
        status: 405,
        body: {
          message: "Method not allowed",
        },
      };
    }

    const action = request.headers.get("x-trigger-action");

    if (!action) {
      return {
        status: 400,
        body: {
          message: "Missing x-trigger-action header",
        },
      };
    }

    switch (action) {
      case "PING": {
        return {
          status: 200,
          body: {
            message: "PONG",
          },
        };
      }
      case "GET_ENDPOINT_DATA": {
        // if the x-trigger-job-id header is set, we return the job with that id
        const jobId = request.headers.get("x-trigger-job-id");

        if (jobId) {
          const job = this.#registeredJobs[jobId];

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
          dynamicTriggers: Object.values(this.#registeredDynamicTriggers).map(
            (trigger) => ({
              id: trigger.id,
              jobs: this.#jobMetadataByDynamicTriggers[trigger.id] ?? [],
            })
          ),
          dynamicSchedules: Object.entries(this.#registeredSchedules).map(
            ([id, jobs]) => ({
              id,
              jobs,
            })
          ),
        };

        // if the x-trigger-job-id header is not set, we return all jobs
        return {
          status: 200,
          body,
        };
      }
      case "INITIALIZE": {
        await this.listen();

        return {
          status: 200,
          body: {
            message: "Initialized",
          },
        };
      }
      case "INITIALIZE_TRIGGER": {
        const json = await request.json();
        const body = InitializeTriggerBodySchema.safeParse(json);

        if (!body.success) {
          return {
            status: 400,
            body: {
              message: "Invalid trigger body",
            },
          };
        }

        const dynamicTrigger = this.#registeredDynamicTriggers[body.data.id];

        if (!dynamicTrigger) {
          return {
            status: 404,
            body: {
              message: "Dynamic trigger not found",
            },
          };
        }

        return {
          status: 200,
          body: dynamicTrigger.registeredTriggerForParams(body.data.params),
        };
      }
      case "EXECUTE_JOB": {
        const json = await request.json();
        const execution = RunJobBodySchema.safeParse(json);

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

        return {
          status: 200,
          body: results,
        };
      }
      case "PREPROCESS_RUN": {
        const json = await request.json();
        const body = PreprocessRunBodySchema.safeParse(json);

        if (!body.success) {
          return {
            status: 400,
            body: {
              message: "Invalid body",
            },
          };
        }

        const job = this.#registeredJobs[body.data.job.id];

        if (!job) {
          return {
            status: 404,
            body: {
              message: "Job not found",
            },
          };
        }

        const results = await this.#preprocessRun(body.data, job);

        return {
          status: 200,
          body: {
            abort: results.abort,
            properties: results.properties,
          },
        };
      }
      case "DELIVER_HTTP_SOURCE_REQUEST": {
        const headers = HttpSourceRequestHeadersSchema.safeParse(
          Object.fromEntries(request.headers.entries())
        );

        if (!headers.success) {
          return {
            status: 400,
            body: {
              message: "Invalid headers",
            },
          };
        }

        const sourceRequest = new Request(headers.data["x-ts-http-url"], {
          method: headers.data["x-ts-http-method"],
          headers: headers.data["x-ts-http-headers"],
          body:
            headers.data["x-ts-http-method"] !== "GET"
              ? request.body
              : undefined,
        });

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

    return {
      status: 405,
      body: {
        message: "Method not allowed",
      },
    };
  }

  attach(job: Job<Trigger<any>, any>): void {
    if (!job.enabled) {
      return;
    }

    this.#registeredJobs[job.id] = job;

    job.trigger.attachToJob(this, job);
  }

  attachDynamicTrigger(trigger: DynamicTrigger<any, any>): void {
    this.#registeredDynamicTriggers[trigger.id] = trigger;

    new Job(this, {
      id: `register-dynamic-trigger-${trigger.id}`,
      name: `Register dynamic trigger ${trigger.id}`,
      version: trigger.source.version,
      trigger: new EventTrigger({
        event: registerSourceEvent,
        filter: { dynamicTriggerId: [trigger.id] },
      }),
      integrations: {
        integration: trigger.source.integration,
      },
      run: async (event, io, ctx) => {
        const updates = await trigger.source.register(
          event.source.params,
          event,
          io,
          ctx
        );

        if (!updates) {
          // TODO: do something here?
          return;
        }

        return await io.updateSource("update-source", {
          key: event.source.key,
          ...updates,
        });
      },
      // @ts-ignore
      __internal: true,
    });
  }

  attachJobToDynamicTrigger(
    job: Job<Trigger<any>, any>,
    trigger: DynamicTrigger<any, any>
  ): void {
    const jobs = this.#jobMetadataByDynamicTriggers[trigger.id] ?? [];

    jobs.push({ id: job.id, version: job.version });

    this.#jobMetadataByDynamicTriggers[trigger.id] = jobs;
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

    new Job(this, {
      id: options.key,
      name: options.key,
      version: options.source.version,
      trigger: new EventTrigger({
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

  attachDynamicSchedule(key: string, job: Job<Trigger<any>, any>): void {
    const jobs = this.#registeredSchedules[key] ?? [];

    jobs.push({ id: job.id, version: job.version });

    this.#registeredSchedules[key] = jobs;
  }

  async registerTrigger(id: string, key: string, options: RegisterTriggerBody) {
    return this.#client.registerTrigger(this.id, id, key, options);
  }

  async getAuth(id: string) {
    return this.#client.getAuth(this.id, id);
  }

  async sendEvent(event: SendEvent, options?: SendEventOptions) {
    return this.#client.sendEvent(event, options);
  }

  async registerSchedule(id: string, key: string, schedule: ScheduleMetadata) {
    return this.#client.registerSchedule(this.id, id, key, schedule);
  }

  async unregisterSchedule(id: string, key: string) {
    return this.#client.unregisterSchedule(this.id, id, key);
  }

  authorized(apiKey?: string | null) {
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
      url: this.url,
      name: this.id,
    });
  }

  async #preprocessRun(
    body: PreprocessRunBody,
    job: Job<Trigger<EventSpecification<any>>, any>
  ) {
    const context = this.#createPreprocessRunContext(body);

    const parsedPayload = job.trigger.event.parsePayload(
      body.event.payload ?? {}
    );

    const properties = job.trigger.event.runProperties?.(parsedPayload) ?? [];

    return {
      abort: false,
      properties,
    };
  }

  async #executeJob(
    body: RunJobBody,
    job: Job<Trigger<any>, any>
  ): Promise<RunJobResponse> {
    this.#logger.debug("executing job", { execution: body, job: job.toJSON() });

    const context = this.#createRunContext(body);

    const io = new IO({
      id: body.run.id,
      cachedTasks: body.tasks,
      apiClient: this.#client,
      logger: this.#logger,
      client: this,
      context,
    });

    const ioWithConnections = createIOWithIntegrations(
      io,
      body.connections,
      job.options.integrations
    );

    try {
      const output = await job.options.run(
        job.trigger.event.parsePayload(body.event.payload ?? {}),
        ioWithConnections,
        context
      );

      return { status: "SUCCESS", output };
    } catch (error) {
      if (error instanceof ResumeWithTask) {
        return { status: "RESUME_WITH_TASK", task: error.task };
      }

      if (error instanceof TaskError) {
        const errorWithStack = ErrorWithStackSchema.safeParse(error.cause);

        if (errorWithStack.success) {
          return {
            status: "ERROR",
            error: errorWithStack.data,
            task: error.task,
          };
        }

        return {
          status: "ERROR",
          error: { message: "Unknown error" },
          task: error.task,
        };
      }

      const errorWithStack = ErrorWithStackSchema.safeParse(error);

      if (errorWithStack.success) {
        return { status: "ERROR", error: errorWithStack.data };
      }

      return {
        status: "ERROR",
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
      account: execution.account,
    };
  }

  #createPreprocessRunContext(
    body: PreprocessRunBody
  ): TriggerPreprocessContext {
    const { event, organization, environment, job, run, account } = body;

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
      account,
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
    sourceRequest: Request
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

function buildClientUrl(url?: string): string {
  if (!url) {
    // Try and get the host from the environment
    const host =
      process.env.TRIGGER_CLIENT_HOST ??
      process.env.HOST ??
      process.env.HOSTNAME ??
      process.env.NOW_URL ??
      process.env.VERCEL_URL;

    // If the host is set, we return it + the path
    if (host) {
      return "https://" + host;
    }

    // If we can't get the host, we throw an error
    throw new Error(
      "Could not determine the url for this TriggerClient. Please set the TRIGGER_CLIENT_HOST environment variable or pass in the `url` option to the TriggerClient constructor."
    );
  }

  // Check to see if url has the protocol, and if it doesn't, add it
  if (!url.startsWith("http")) {
    return "https://" + url;
  }

  return url;
}

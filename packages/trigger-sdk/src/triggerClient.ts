import {
  API_VERSIONS,
  ConnectionAuth,
  DeserializedJson,
  ErrorWithStackSchema,
  GetRunOptionsWithTaskDetails,
  GetRunsOptions,
  HandleTriggerSource,
  HttpSourceRequestHeadersSchema,
  HttpSourceResponseMetadata,
  IndexEndpointResponse,
  InitializeTriggerBodySchema,
  IntegrationConfig,
  JobMetadata,
  LogLevel,
  Logger,
  NormalizedResponse,
  PreprocessRunBody,
  PreprocessRunBodySchema,
  Prettify,
  REGISTER_SOURCE_EVENT_V2,
  RegisterSourceEventSchemaV2,
  RegisterSourceEventV2,
  RegisterTriggerBodyV2,
  RunJobBody,
  RunJobBodySchema,
  RunJobResponse,
  ScheduleMetadata,
  SendEvent,
  SendEventOptions,
  SourceMetadataV2,
  StatusUpdate,
} from "@trigger.dev/core";
import { ApiClient } from "./apiClient";
import {
  AutoYieldExecutionError,
  AutoYieldWithCompletedTaskExecutionError,
  CanceledWithTaskError,
  ParsedPayloadSchemaError,
  ResumeWithTaskError,
  RetryWithTaskError,
  YieldExecutionError,
} from "./errors";
import { TriggerIntegration } from "./integrations";
import { IO, IOStats } from "./io";
import { createIOWithIntegrations } from "./ioWithIntegrations";
import { Job, JobOptions } from "./job";
import { runLocalStorage } from "./runLocalStorage";
import { DynamicTrigger, DynamicTriggerOptions } from "./triggers/dynamic";
import { EventTrigger } from "./triggers/eventTrigger";
import { ExternalSource } from "./triggers/externalSource";
import { DynamicIntervalOptions, DynamicSchedule } from "./triggers/scheduled";
import type {
  EventSpecification,
  Trigger,
  TriggerContext,
  TriggerPreprocessContext,
} from "./types";

const registerSourceEvent: EventSpecification<RegisterSourceEventV2> = {
  name: REGISTER_SOURCE_EVENT_V2,
  title: "Register Source",
  source: "internal",
  icon: "register-source",
  parsePayload: RegisterSourceEventSchemaV2.parse,
};

import * as packageJson from "../package.json";

export type TriggerClientOptions = {
  /** The `id` property is used to uniquely identify the client.
   */
  id: string;
  /** The `apiKey` property is the API Key for your Trigger.dev environment. We
      recommend using an environment variable to store your API Key. */
  apiKey?: string;
  /** The `apiUrl` property is an optional property that specifies the API URL. You
      only need to specify this if you are not using Trigger.dev Cloud and are
      running your own Trigger.dev instance. */
  apiUrl?: string;
  /** The `logLevel` property is an optional property that specifies the level of
      logging for the TriggerClient. The level is inherited by all Jobs that use this Client, unless they also specify a `logLevel`. */
  logLevel?: LogLevel;
  /** Very verbose log messages, defaults to false. */
  verbose?: boolean;
  /** Default is unset and off. If set to true it will log to the server's console as well as the Trigger.dev platform */
  ioLogLocalEnabled?: boolean;
};

export type AuthResolverResult = {
  type: "apiKey" | "oauth";
  token: string;
  additionalFields?: Record<string, string>;
};

export type TriggerAuthResolver = (
  ctx: TriggerContext,
  integration: TriggerIntegration
) => Promise<AuthResolverResult | void | undefined>;

/** A [TriggerClient](https://trigger.dev/docs/documentation/concepts/client-adaptors) is used to connect to a specific [Project](https://trigger.dev/docs/documentation/concepts/projects) by using an [API Key](https://trigger.dev/docs/documentation/concepts/environments-apikeys). */
export class TriggerClient {
  #options: TriggerClientOptions;
  #registeredJobs: Record<string, Job<Trigger<EventSpecification<any>>, any>> = {};
  #registeredSources: Record<string, SourceMetadataV2> = {};
  #registeredHttpSourceHandlers: Record<
    string,
    (
      source: HandleTriggerSource,
      request: Request
    ) => Promise<{
      events: Array<SendEvent>;
      response?: NormalizedResponse;
      metadata?: HttpSourceResponseMetadata;
    } | void>
  > = {};
  #registeredDynamicTriggers: Record<
    string,
    DynamicTrigger<EventSpecification<any>, ExternalSource<any, any, any>>
  > = {};
  #jobMetadataByDynamicTriggers: Record<string, Array<{ id: string; version: string }>> = {};
  #registeredSchedules: Record<string, Array<{ id: string; version: string }>> = {};
  #authResolvers: Record<string, TriggerAuthResolver> = {};

  #client: ApiClient;
  #internalLogger: Logger;
  id: string;

  constructor(options: Prettify<TriggerClientOptions>) {
    this.id = options.id;
    this.#options = options;
    this.#client = new ApiClient(this.#options);
    this.#internalLogger = new Logger("trigger.dev", this.#options.verbose ? "debug" : "log", [
      "output",
      "noopTasksSet",
    ]);
  }

  async handleRequest(
    request: Request,
    timeOrigin: number = performance.now()
  ): Promise<NormalizedResponse> {
    this.#internalLogger.debug("handling request", {
      url: request.url,
      headers: Object.fromEntries(request.headers.entries()),
      method: request.method,
    });

    const apiKey = request.headers.get("x-trigger-api-key");
    const triggerVersion = request.headers.get("x-trigger-version");

    const authorization = this.authorized(apiKey);

    switch (authorization) {
      case "authorized": {
        break;
      }
      case "missing-client": {
        return {
          status: 401,
          body: {
            message: "Unauthorized: client missing apiKey",
          },
          headers: this.#standardResponseHeaders(timeOrigin),
        };
      }
      case "missing-header": {
        return {
          status: 401,
          body: {
            message: "Unauthorized: missing x-trigger-api-key header",
          },
          headers: this.#standardResponseHeaders(timeOrigin),
        };
      }
      case "unauthorized": {
        return {
          status: 401,
          body: {
            message: `Forbidden: client apiKey mismatch: Make sure you are using the correct API Key for your environment`,
          },
          headers: this.#standardResponseHeaders(timeOrigin),
        };
      }
    }

    if (request.method !== "POST") {
      return {
        status: 405,
        body: {
          message: "Method not allowed (only POST is allowed)",
        },
        headers: this.#standardResponseHeaders(timeOrigin),
      };
    }

    const action = request.headers.get("x-trigger-action");

    if (!action) {
      return {
        status: 400,
        body: {
          message: "Missing x-trigger-action header",
        },
        headers: this.#standardResponseHeaders(timeOrigin),
      };
    }

    switch (action) {
      case "PING": {
        const endpointId = request.headers.get("x-trigger-endpoint-id");

        if (!endpointId) {
          return {
            status: 200,
            body: {
              ok: false,
              error: "Missing endpoint ID",
            },
            headers: this.#standardResponseHeaders(timeOrigin),
          };
        }

        if (this.id !== endpointId) {
          return {
            status: 200,
            body: {
              ok: false,
              error: `Endpoint ID mismatch error. Expected ${this.id}, got ${endpointId}`,
            },
            headers: this.#standardResponseHeaders(timeOrigin),
          };
        }

        return {
          status: 200,
          body: {
            ok: true,
          },
          headers: this.#standardResponseHeaders(timeOrigin),
        };
      }
      case "INDEX_ENDPOINT": {
        const body: IndexEndpointResponse = {
          jobs: this.#buildJobsIndex(),
          sources: Object.values(this.#registeredSources),
          dynamicTriggers: Object.values(this.#registeredDynamicTriggers).map((trigger) => ({
            id: trigger.id,
            jobs: this.#jobMetadataByDynamicTriggers[trigger.id] ?? [],
            registerSourceJob: {
              id: dynamicTriggerRegisterSourceJobId(trigger.id),
              version: trigger.source.version,
            },
          })),
          dynamicSchedules: Object.entries(this.#registeredSchedules).map(([id, jobs]) => ({
            id,
            jobs,
          })),
        };

        // if the x-trigger-job-id header is not set, we return all jobs
        return {
          status: 200,
          body,
          headers: this.#standardResponseHeaders(timeOrigin),
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
          headers: this.#standardResponseHeaders(timeOrigin),
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

        const results = await this.#executeJob(execution.data, job, timeOrigin, triggerVersion);

        return {
          status: 200,
          body: results,
          headers: this.#standardResponseHeaders(timeOrigin),
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
          headers: this.#standardResponseHeaders(timeOrigin),
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

        const sourceRequestNeedsBody = headers.data["x-ts-http-method"] !== "GET";

        const sourceRequestInit: RequestInit = {
          method: headers.data["x-ts-http-method"],
          headers: headers.data["x-ts-http-headers"],
          body: sourceRequestNeedsBody ? request.body : undefined,
        };

        if (sourceRequestNeedsBody) {
          try {
            // @ts-ignore
            sourceRequestInit.duplex = "half";
          } catch (error) {
            // ignore
          }
        }

        const sourceRequest = new Request(headers.data["x-ts-http-url"], sourceRequestInit);

        const key = headers.data["x-ts-key"];
        const dynamicId = headers.data["x-ts-dynamic-id"];
        const secret = headers.data["x-ts-secret"];
        const params = headers.data["x-ts-params"];
        const data = headers.data["x-ts-data"];
        const auth = headers.data["x-ts-auth"];
        const inputMetadata = headers.data["x-ts-metadata"];

        const source = {
          key,
          dynamicId,
          secret,
          params,
          data,
          auth,
          metadata: inputMetadata,
        };

        const { response, events, metadata } = await this.#handleHttpSourceRequest(
          source,
          sourceRequest
        );

        return {
          status: 200,
          body: {
            events,
            response,
            metadata,
          },
          headers: this.#standardResponseHeaders(timeOrigin),
        };
      }
      case "VALIDATE": {
        return {
          status: 200,
          body: {
            ok: true,
            endpointId: this.id,
          },
          headers: this.#standardResponseHeaders(timeOrigin),
        };
      }
      case "PROBE_EXECUTION_TIMEOUT": {
        const json = await request.json();
        // Keep this request open for max 15 minutes so the server can detect when the function execution limit is exceeded
        const timeout = json?.timeout ?? 15 * 60 * 1000;

        await new Promise((resolve) => setTimeout(resolve, timeout));

        return {
          status: 200,
          body: {
            ok: true,
          },
          headers: this.#standardResponseHeaders(timeOrigin),
        };
      }
    }

    return {
      status: 405,
      body: {
        message: "Method not allowed",
      },
      headers: this.#standardResponseHeaders(timeOrigin),
    };
  }

  defineJob<
    TTrigger extends Trigger<EventSpecification<any>>,
    TIntegrations extends Record<string, TriggerIntegration> = {},
  >(options: JobOptions<TTrigger, TIntegrations>) {
    return new Job<TTrigger, TIntegrations>(this, options);
  }

  defineAuthResolver(
    integration: TriggerIntegration,
    resolver: TriggerAuthResolver
  ): TriggerClient {
    this.#authResolvers[integration.id] = resolver;

    return this;
  }

  defineDynamicSchedule(options: DynamicIntervalOptions): DynamicSchedule {
    return new DynamicSchedule(this, options);
  }

  defineDynamicTrigger<
    TEventSpec extends EventSpecification<any>,
    TExternalSource extends ExternalSource<any, any, any>,
  >(
    options: DynamicTriggerOptions<TEventSpec, TExternalSource>
  ): DynamicTrigger<TEventSpec, TExternalSource> {
    return new DynamicTrigger(this, options);
  }

  attach(job: Job<Trigger<any>, any>): void {
    this.#registeredJobs[job.id] = job;

    job.trigger.attachToJob(this, job);
  }

  attachDynamicTrigger(trigger: DynamicTrigger<any, any>): void {
    this.#registeredDynamicTriggers[trigger.id] = trigger;

    this.defineJob({
      id: dynamicTriggerRegisterSourceJobId(trigger.id),
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
        const updates = await trigger.source.register(event.source.params, event, io, ctx);

        if (!updates) {
          // TODO: do something here?
          return;
        }

        return await io.updateSource("update-source", {
          key: event.source.key,
          ...updates,
        });
      },
      __internal: true,
    });
  }

  attachJobToDynamicTrigger(job: Job<Trigger<any>, any>, trigger: DynamicTrigger<any, any>): void {
    const jobs = this.#jobMetadataByDynamicTriggers[trigger.id] ?? [];

    jobs.push({ id: job.id, version: job.version });

    this.#jobMetadataByDynamicTriggers[trigger.id] = jobs;
  }

  attachSource(options: {
    key: string;
    source: ExternalSource<any, any>;
    event: EventSpecification<any>;
    params: any;
    options?: Record<string, string[]>;
  }): void {
    this.#registeredHttpSourceHandlers[options.key] = async (s, r) => {
      return await options.source.handle(s, r, this.#internalLogger);
    };

    let registeredSource = this.#registeredSources[options.key];

    if (!registeredSource) {
      registeredSource = {
        version: "2",
        channel: options.source.channel,
        key: options.key,
        params: options.params,
        options: {},
        integration: {
          id: options.source.integration.id,
          metadata: options.source.integration.metadata,
          authSource: options.source.integration.authSource,
        },
        registerSourceJob: {
          id: options.key,
          version: options.source.version,
        },
      };
    }

    //combined the previous source options with this one, making sure to include event
    const newOptions = deepMergeOptions(
      {
        event: typeof options.event.name === "string" ? [options.event.name] : options.event.name,
      },
      options.options ?? {}
    );
    registeredSource.options = deepMergeOptions(registeredSource.options, newOptions);

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
      run: async (event, io, ctx) => {
        const updates = await options.source.register(options.params, event, io, ctx);

        if (!updates) {
          // TODO: do something here?
          return;
        }

        return await io.updateSource("update-source", {
          key: options.key,
          ...updates,
        });
      },
      __internal: true,
    });
  }

  attachDynamicSchedule(key: string): void {
    const jobs = this.#registeredSchedules[key] ?? [];

    this.#registeredSchedules[key] = jobs;
  }

  attachDynamicScheduleToJob(key: string, job: Job<Trigger<any>, any>): void {
    const jobs = this.#registeredSchedules[key] ?? [];

    jobs.push({ id: job.id, version: job.version });

    this.#registeredSchedules[key] = jobs;
  }

  async registerTrigger(id: string, key: string, options: RegisterTriggerBodyV2) {
    return this.#client.registerTrigger(this.id, id, key, options);
  }

  async getAuth(id: string) {
    return this.#client.getAuth(this.id, id);
  }

  /** You can call this function from anywhere in your backend to send an event. The other way to send an event is by using [`io.sendEvent()`](https://trigger.dev/docs/sdk/io/sendevent) from inside a `run()` function.
   * @param event The event to send.
   * @param options Options for sending the event.
   * @returns A promise that resolves to the event details
   */
  async sendEvent(event: SendEvent, options?: SendEventOptions) {
    return this.#client.sendEvent(event, options);
  }

  async cancelEvent(eventId: string) {
    return this.#client.cancelEvent(eventId);
  }

  async updateStatus(runId: string, id: string, status: StatusUpdate) {
    return this.#client.updateStatus(runId, id, status);
  }

  async registerSchedule(id: string, key: string, schedule: ScheduleMetadata) {
    return this.#client.registerSchedule(this.id, id, key, schedule);
  }

  async unregisterSchedule(id: string, key: string) {
    return this.#client.unregisterSchedule(this.id, id, key);
  }

  async getEvent(eventId: string) {
    return this.#client.getEvent(eventId);
  }

  async getRun(runId: string, options?: GetRunOptionsWithTaskDetails) {
    return this.#client.getRun(runId, options);
  }

  async cancelRun(runId: string) {
    return this.#client.cancelRun(runId);
  }

  async getRuns(jobSlug: string, options?: GetRunsOptions) {
    return this.#client.getRuns(jobSlug, options);
  }

  async getRunStatuses(runId: string) {
    return this.#client.getRunStatuses(runId);
  }

  authorized(
    apiKey?: string | null
  ): "authorized" | "unauthorized" | "missing-client" | "missing-header" {
    if (typeof apiKey !== "string") {
      return "missing-header";
    }

    const localApiKey = this.#options.apiKey ?? process.env.TRIGGER_API_KEY;

    if (!localApiKey) {
      return "missing-client";
    }

    return apiKey === localApiKey ? "authorized" : "unauthorized";
  }

  apiKey() {
    return this.#options.apiKey ?? process.env.TRIGGER_API_KEY;
  }

  async #preprocessRun(body: PreprocessRunBody, job: Job<Trigger<EventSpecification<any>>, any>) {
    const context = this.#createPreprocessRunContext(body);

    const parsedPayload = job.trigger.event.parsePayload(body.event.payload ?? {});

    const properties = job.trigger.event.runProperties?.(parsedPayload) ?? [];

    return {
      abort: false,
      properties,
    };
  }

  async #executeJob(
    body: RunJobBody,
    job: Job<Trigger<any>, Record<string, TriggerIntegration>>,
    timeOrigin: number,
    triggerVersion: string | null
  ): Promise<RunJobResponse> {
    this.#internalLogger.debug("executing job", {
      execution: body,
      job: job.id,
      version: job.version,
      triggerVersion,
    });

    const context = this.#createRunContext(body);

    const io = new IO({
      id: body.run.id,
      cachedTasks: body.tasks,
      cachedTasksCursor: body.cachedTaskCursor,
      yieldedExecutions: body.yieldedExecutions ?? [],
      noopTasksSet: body.noopTasksSet,
      apiClient: this.#client,
      logger: this.#internalLogger,
      client: this,
      context,
      jobLogLevel: job.logLevel ?? this.#options.logLevel ?? "info",
      jobLogger: this.#options.ioLogLocalEnabled
        ? new Logger(job.id, job.logLevel ?? this.#options.logLevel ?? "info")
        : undefined,
      serverVersion: triggerVersion,
      timeOrigin,
      executionTimeout: body.runChunkExecutionLimit,
    });

    const resolvedConnections = await this.#resolveConnections(
      context,
      job.options.integrations,
      body.connections
    );

    if (!resolvedConnections.ok) {
      return {
        status: "UNRESOLVED_AUTH_ERROR",
        issues: resolvedConnections.issues,
      };
    }

    const ioWithConnections = createIOWithIntegrations(
      io,
      resolvedConnections.data,
      job.options.integrations
    );

    try {
      const output = await runLocalStorage.runWith({ io, ctx: context }, () => {
        return job.options.run(
          job.trigger.event.parsePayload(body.event.payload ?? {}),
          ioWithConnections,
          context
        );
      });

      if (this.#options.verbose) {
        this.#logIOStats(io.stats);
      }

      return { status: "SUCCESS", output };
    } catch (error) {
      if (this.#options.verbose) {
        this.#logIOStats(io.stats);
      }

      if (error instanceof AutoYieldExecutionError) {
        return {
          status: "AUTO_YIELD_EXECUTION",
          location: error.location,
          timeRemaining: error.timeRemaining,
          timeElapsed: error.timeElapsed,
          limit: body.runChunkExecutionLimit,
        };
      }

      if (error instanceof AutoYieldWithCompletedTaskExecutionError) {
        return {
          status: "AUTO_YIELD_EXECUTION_WITH_COMPLETED_TASK",
          id: error.id,
          properties: error.properties,
          output: error.output,
          data: {
            ...error.data,
            limit: body.runChunkExecutionLimit,
          },
        };
      }

      if (error instanceof YieldExecutionError) {
        return { status: "YIELD_EXECUTION", key: error.key };
      }

      if (error instanceof ParsedPayloadSchemaError) {
        return { status: "INVALID_PAYLOAD", errors: error.schemaErrors };
      }

      if (error instanceof ResumeWithTaskError) {
        return { status: "RESUME_WITH_TASK", task: error.task };
      }

      if (error instanceof RetryWithTaskError) {
        return {
          status: "RETRY_WITH_TASK",
          task: error.task,
          error: error.cause,
          retryAt: error.retryAt,
        };
      }

      if (error instanceof CanceledWithTaskError) {
        return {
          status: "CANCELED",
          task: error.task,
        };
      }

      if (error instanceof RetryWithTaskError) {
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
    const { event, organization, environment, job, run, source } = execution;

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
      source,
    };
  }

  #createPreprocessRunContext(body: PreprocessRunBody): TriggerPreprocessContext {
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
      auth?: ConnectionAuth;
      metadata?: DeserializedJson;
    },
    sourceRequest: Request
  ): Promise<{
    response: NormalizedResponse;
    events: SendEvent[];
    metadata?: HttpSourceResponseMetadata;
  }> {
    this.#internalLogger.debug("Handling HTTP source request", {
      source,
    });

    if (source.dynamicId) {
      const dynamicTrigger = this.#registeredDynamicTriggers[source.dynamicId];

      if (!dynamicTrigger) {
        this.#internalLogger.debug("No dynamic trigger registered for HTTP source", {
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
        this.#internalLogger
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
        metadata: results.metadata,
      };
    }

    const handler = this.#registeredHttpSourceHandlers[source.key];

    if (!handler) {
      this.#internalLogger.debug("No handler registered for HTTP source", {
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
      metadata: results.metadata,
    };
  }

  async #resolveConnections(
    ctx: TriggerContext,
    integrations?: Record<string, TriggerIntegration>,
    connections?: Record<string, ConnectionAuth>
  ): Promise<
    | { ok: true; data: Record<string, ConnectionAuth> }
    | { ok: false; issues: Record<string, { id: string; error: string }> }
  > {
    if (!integrations) {
      return { ok: true, data: {} };
    }

    const resolvedAuthResults = await Promise.all(
      Object.keys(integrations).map(async (key) => {
        const integration = integrations[key];
        const auth = (connections ?? {})[key];

        const result = await this.#resolveConnection(ctx, integration, auth);

        if (result.ok) {
          return {
            ok: true as const,
            auth: result.auth,
            key,
          };
        } else {
          return {
            ok: false as const,
            error: result.error,
            key,
          };
        }
      })
    );

    const allResolved = resolvedAuthResults.every((result) => result.ok);

    if (allResolved) {
      return {
        ok: true,
        data: resolvedAuthResults.reduce((acc: Record<string, ConnectionAuth>, result) => {
          acc[result.key] = result.auth!;

          return acc;
        }, {}),
      };
    } else {
      return {
        ok: false,
        issues: resolvedAuthResults.reduce(
          (acc: Record<string, { id: string; error: string }>, result) => {
            if (result.ok) {
              return acc;
            }

            const integration = integrations[result.key];

            acc[result.key] = { id: integration.id, error: result.error };

            return acc;
          },
          {}
        ),
      };
    }
  }

  async #resolveConnection(
    ctx: TriggerContext,
    integration: TriggerIntegration,
    auth?: ConnectionAuth
  ): Promise<{ ok: true; auth: ConnectionAuth | undefined } | { ok: false; error: string }> {
    if (auth) {
      return { ok: true, auth };
    }

    const authResolver = this.#authResolvers[integration.id];

    if (!authResolver) {
      if (integration.authSource === "HOSTED") {
        return {
          ok: false,
          error: `Something went wrong: Integration ${integration.id} is missing auth credentials from Trigger.dev`,
        };
      }

      return {
        ok: true,
        auth: undefined,
      };
    }

    try {
      const resolvedAuth = await authResolver(ctx, integration);

      if (!resolvedAuth) {
        return {
          ok: false,
          error: `Auth could not be resolved for ${integration.id}: auth resolver returned null or undefined`,
        };
      }

      return {
        ok: true,
        auth:
          resolvedAuth.type === "apiKey"
            ? {
                type: "apiKey",
                accessToken: resolvedAuth.token,
                additionalFields: resolvedAuth.additionalFields,
              }
            : {
                type: "oauth2",
                accessToken: resolvedAuth.token,
                additionalFields: resolvedAuth.additionalFields,
              },
      };
    } catch (resolverError) {
      if (resolverError instanceof Error) {
        return {
          ok: false,
          error: `Auth could not be resolved for ${integration.id}: auth resolver threw. ${resolverError.name}: ${resolverError.message}`,
        };
      } else if (typeof resolverError === "string") {
        return {
          ok: false,
          error: `Auth could not be resolved for ${integration.id}: auth resolver threw an error: ${resolverError}`,
        };
      }

      return {
        ok: false,
        error: `Auth could not be resolved for ${
          integration.id
        }: auth resolver threw an unknown error: ${JSON.stringify(resolverError)}`,
      };
    }
  }

  #buildJobsIndex(): IndexEndpointResponse["jobs"] {
    return Object.values(this.#registeredJobs).map((job) => this.#buildJobIndex(job));
  }

  #buildJobIndex(job: Job<Trigger<any>, any>): IndexEndpointResponse["jobs"][number] {
    const internal = job.options.__internal as JobMetadata["internal"];

    return {
      id: job.id,
      name: job.name,
      version: job.version,
      event: job.trigger.event,
      trigger: job.trigger.toJSON(),
      integrations: this.#buildJobIntegrations(job),
      startPosition: "latest", // job is deprecated, leaving job for now to make sure newer clients work with older servers
      enabled: job.enabled,
      preprocessRuns: job.trigger.preprocessRuns,
      internal,
    };
  }

  #buildJobIntegrations(
    job: Job<Trigger<any>, Record<string, TriggerIntegration>>
  ): IndexEndpointResponse["jobs"][number]["integrations"] {
    return Object.keys(job.options.integrations ?? {}).reduce(
      (acc: Record<string, IntegrationConfig>, key) => {
        const integration = job.options.integrations![key];

        acc[key] = this.#buildJobIntegration(integration);

        return acc;
      },
      {}
    );
  }

  #buildJobIntegration(
    integration: TriggerIntegration
  ): IndexEndpointResponse["jobs"][number]["integrations"][string] {
    const authSource = this.#authResolvers[integration.id] ? "RESOLVER" : integration.authSource;

    return {
      id: integration.id,
      metadata: integration.metadata,
      authSource,
    };
  }

  #logIOStats(stats: IOStats) {
    this.#internalLogger.debug("IO stats", {
      stats,
    });
  }

  #standardResponseHeaders(start: number) {
    return {
      "Trigger-Version": API_VERSIONS.LAZY_LOADED_CACHED_TASKS,
      "Trigger-SDK-Version": packageJson.version,
      "X-Trigger-Request-Timing": `dur=${performance.now() - start / 1000.0}`,
    };
  }
}

function dynamicTriggerRegisterSourceJobId(id: string) {
  return `register-dynamic-trigger-${id}`;
}

type Options = Record<string, string[]>;

function deepMergeOptions(obj1: Options, obj2: Options): Options {
  const mergedOptions: Options = { ...obj1 };

  for (const key in obj2) {
    if (obj2.hasOwnProperty(key)) {
      if (key in mergedOptions) {
        mergedOptions[key] = [...mergedOptions[key], ...obj2[key]];
      } else {
        mergedOptions[key] = obj2[key];
      }
    }
  }

  return mergedOptions;
}

import { RunJobBody, SendEvent, SendEventBodySchema, SendEventOptions } from "@trigger.dev/core";
import type {
  EventSpecification,
  IOWithIntegrations,
  IntegrationClient,
  Job,
  Trigger,
  TriggerClient,
  TriggerEventType,
  TriggerIntegration,
} from "@trigger.dev/sdk";
import { vi as vitestVi } from "vitest";
import { entries } from "./utils";

declare module "vitest" {
  interface Assertion<T = any> extends CustomMatchers<T> {}
  interface AsymmetricMatchersContaining extends CustomMatchers {}
}

interface CustomMatchers<R = unknown> {
  toHaveSucceeded(): R;
}

// @ts-ignore
declare module "expect" {
  interface AsymmetricMatchers {
    toHaveSucceeded(): void;
  }
  interface Matchers<R> {
    toHaveSucceeded(): R;
  }
}

let promiseCounter = 0;

export const toHaveSucceeded = (received: any) => {
  if (received?.status === "SUCCESS") {
    return {
      message: () => "run succeeded",
      pass: true,
    };
  } else {
    return {
      message: () =>
        received instanceof Promise
          ? promiseCounter++ < 1
            ? "you passed a promise, please don't do that again"
            : "you did it again.."
          : "run failed",
      pass: false,
    };
  }
};

type TriggerAction =
  | "DELIVER_HTTP_SOURCE_REQUEST"
  | "EXECUTE_JOB"
  | "INDEX_ENDPOINT"
  | "INITIALIZE_TRIGGER"
  | "PING"
  | "PREPROCESS_RUN"
  | "VALIDATE";

const buildRequest = (action: TriggerAction, apiKey: string, opts: Record<string, any> = {}) => {
  if (action === "DELIVER_HTTP_SOURCE_REQUEST") {
    throw new Error(`action ${action} not implemented yet`);
  }
  return new Request("https://example.com/trigger", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-trigger-api-key": apiKey,
      "x-trigger-action": action,
      "x-trigger-endpoint-id": opts.endpointId,
      "x-trigger-job-id": opts.jobId,
    },
    body: JSON.stringify(opts.body),
  });
};

const buildRequestBody = (event: RunJobBody["event"], job: RunJobBody["job"]): RunJobBody => ({
  event,
  job,
  run: {
    id: String(Math.random()),
    isTest: false,
    isRetry: false,
    startedAt: new Date(),
  },
  environment: {
    id: String(Math.random()),
    slug: "test-env",
    type: "DEVELOPMENT",
  },
  organization: {
    id: String(Math.random()),
    title: "Test Org",
    slug: "test-org",
  },
});

export const createJobTester =
  (vi: typeof vitestVi) =>
  async <
    TTrigger extends Trigger<EventSpecification<any>>,
    TIntegrations extends Record<string, TriggerIntegration<IntegrationClient<any, any>>> = {},
  >(
    job: Job<TTrigger, TIntegrations>,
    opts: {
      payload?: TriggerEventType<TTrigger>;
      tasks?: Record<string, any>;
    } = {}
  ): Promise<
    {
      io: IOWithIntegrations<TIntegrations>;
      status: string;
      output: any;
    } & Record<string, any>
  > => {
    const mockSendEvent = (client: TriggerClient) =>
      vi
        .spyOn(client, "sendEvent")
        .mockImplementation(
          async (unparsedEvent: SendEvent, unparsedOptions: SendEventOptions = {}) => {
            const body = SendEventBodySchema.parse({
              event: unparsedEvent,
              options: unparsedOptions,
            });
            const { event, options } = body;

            const timestamp = new Date();
            const deliverAt =
              options?.deliverAt ||
              (options?.deliverAfter
                ? new Date(Date.now() + options.deliverAfter * 1000)
                : undefined);

            const eventLog = {
              id: event.id,
              name: event.name,
              payload: event.payload ?? {},
              context: event.context,
              timestamp,
              deliverAt,
              deliveredAt: !deliverAt ? timestamp : undefined,
              cancelledAt: undefined,
            };

            return eventLog;
          }
        );

    const { client, trigger } = job;

    mockSendEvent(client);
    const eventLog = await client.sendEvent({
      name: typeof trigger.event.name === "string" ? trigger.event.name : trigger.event.name[0],
      payload: opts.payload,
    });

    const { integrations, run } = job.options;
    let ioSpy: IOWithIntegrations<TIntegrations> | undefined;

    const taskMockImplementation = async (key: string) => {
      if (!opts.tasks || typeof key !== "string") return;
      return opts.tasks[key];
    };

    job.options.run = (payload, io, ctx) => {
      if (integrations) {
        for (const [integrationName, integration] of entries(integrations)) {
          Object.keys(integration.client.tasks).forEach((taskName) => {
            vi.spyOn(io[integrationName], taskName).mockImplementation((key) =>
              taskMockImplementation(key as string)
            );
          });
        }
      }
      ioSpy = io;
      return run(payload, io, ctx);
    };

    const request = buildRequest("EXECUTE_JOB", client.apiKey() ?? "", {
      body: buildRequestBody(eventLog, job),
      jobId: job.id,
    });
    const requestResult = await client.handleRequest(request);

    const { output, status, ...rest } = requestResult.body;

    return {
      output,
      status,
      ...rest,
      io: ioSpy,
    };
  };

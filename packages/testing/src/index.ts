import {
  RunJobBody,
  SendEvent,
  SendEventBodySchema,
  SendEventOptions,
  ServerTask,
} from "@trigger.dev/core";
import type {
  EventSpecification,
  IO,
  Job,
  Json,
  RunTaskErrorCallback,
  RunTaskOptions,
  Trigger,
  TriggerClient,
  TriggerEventType,
  TriggerIntegration,
} from "@trigger.dev/sdk";
import { Mock, vi as vitestVi } from "vitest";

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
    TIntegrations extends Record<string, TriggerIntegration> = {},
    TTasks extends Record<string, any> = {},
  >(
    job: Job<TTrigger, TIntegrations>,
    opts: {
      payload?: TriggerEventType<TTrigger>;
      tasks?: TTasks;
    } = {}
  ): Promise<
    {
      output: any;
      status: string;
      tasks: Record<keyof TTasks, Mock> & Record<string, Mock>;
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

    mockSendEvent(client!);
    const eventLog = await client!.sendEvent({
      name: typeof trigger.event.name === "string" ? trigger.event.name : trigger.event.name[0],
      payload: opts.payload,
    });

    const tasks = new Proxy({} as Record<string, Mock>, {
      get(target, prop, receiver) {
        if (typeof prop === "string" && !(prop in tasks)) {
          tasks[prop] = vi.fn((params: any) => opts.tasks?.[prop]);
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    async function runTaskMock<T extends Json<T> | void>(
      key: string | any[],
      callback: (task: ServerTask, io: IO) => Promise<T>,
      options?: RunTaskOptions,
      onError?: RunTaskErrorCallback
    ): Promise<T> {
      if (typeof key !== "string") return undefined as T;
      return tasks[key](options?.params);
    }

    const { run } = job.options;

    job.options.run = (payload, io, ctx) => {
      vi.spyOn(io as IO, "runTask").mockImplementation(runTaskMock);
      return run(payload, io, ctx);
    };

    try {
      const request = buildRequest("EXECUTE_JOB", client!.apiKey() ?? "", {
        body: buildRequestBody(eventLog, job),
        jobId: job.id,
      });
      const requestResult = await client!.handleRequest(request);

      const { output, status, ...rest } = requestResult.body;

      return {
        output,
        status,
        tasks,
        ...rest,
      };
    } finally {
      job.options.run = run;
    }
  };

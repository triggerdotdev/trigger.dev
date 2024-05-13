import { z } from "zod";
import * as v from "valibot";
import { wrap } from "@typeschema/valibot";

// https://github.com/t3-oss/t3-env
import { createEnv } from "@t3-oss/env-nextjs";

export const env = createEnv({
  /*
   * Serverside Environment variables, not available on the client.
   * Will throw if you access these variables on the client.
   */
  server: {
    DATABASE_URL: z.string().url(),
    OPEN_AI_API_KEY: z.string().min(1),
  },
  /*
   * Environment variables available on the client (and server).
   *
   * 💡 You'll get type errors if these are not prefixed with NEXT_PUBLIC_.
   */
  client: {
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: z.string().min(1),
  },
  /*
   * Due to how Next.js bundles environment variables on Edge and Client,
   * we need to manually destructure them to make sure all are included in bundle.
   *
   * 💡 You'll get type errors if not all variables from `server` & `client` are included here.
   */
  runtimeEnv: {
    DATABASE_URL: process.env.DATABASE_URL,
    OPEN_AI_API_KEY: process.env.OPEN_AI_API_KEY,
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
  },
});

// borrowed from https://github.com/trpc/trpc/blob/main/packages/server/src/core/parser.ts
export type ParserZodEsque<TInput, TParsedInput> = {
  _input: TInput;
  _output: TParsedInput;
};

export type ParserMyZodEsque<TInput> = {
  parse: (input: any) => TInput;
};

export type ParserSuperstructEsque<TInput> = {
  create: (input: unknown) => TInput;
};

export type ParserCustomValidatorEsque<TInput> = (input: unknown) => Promise<TInput> | TInput;

export type ParserYupEsque<TInput> = {
  validateSync: (input: unknown) => TInput;
};

export type ParserScaleEsque<TInput> = {
  assert(value: unknown): asserts value is TInput;
};

export type ParserWithoutInput<TInput> =
  | ParserCustomValidatorEsque<TInput>
  | ParserMyZodEsque<TInput>
  | ParserScaleEsque<TInput>
  | ParserSuperstructEsque<TInput>
  | ParserYupEsque<TInput>;

export type ParserWithInputOutput<TInput, TParsedInput> = ParserZodEsque<TInput, TParsedInput>;

export type Parser = ParserWithInputOutput<any, any> | ParserWithoutInput<any>;

export type inferParser<TParser extends Parser> = TParser extends ParserWithInputOutput<
  infer $TIn,
  infer $TOut
>
  ? {
      in: $TIn;
      out: $TOut;
    }
  : TParser extends ParserWithoutInput<infer $InOut>
  ? {
      in: $InOut;
      out: $InOut;
    }
  : never;

export type Simplify<TType> = TType extends any[] | Date ? TType : { [K in keyof TType]: TType[K] };

export type TriggerResult = {
  id: string;
};

export type TaskRunResult<TOutput = any> =
  | {
      ok: true;
      id: string;
      output: TOutput;
    }
  | {
      ok: false;
      id: string;
      error: unknown;
    };

export type RunMetadata = {
  run: string;
};

export type inferContext<TContextBuilder extends AnyContextBuilder> =
  TContextBuilder extends ContextBuilder<infer TContext, infer TContextOverrides>
    ? TContext extends UnsetMarker
      ? unknown
      : TContextOverrides extends UnsetMarker
      ? Simplify<TContext>
      : Simplify<Overwrite<TContext, TContextOverrides>>
    : never;

export type RunFnParams<TPayload, TContext extends AnyContextBuilder> = {
  /** Metadata about the task, run, attempt, queue, environment, organization, project and batch.  */
  meta: RunMetadata;

  /** Context added by task middleware  */
  ctx: inferContext<TContext>;

  payload: TPayload;
};

/**
 * See https://github.com/microsoft/TypeScript/issues/41966#issuecomment-758187996
 * Fixes issues with iterating over keys of objects with index signatures.
 * Without this, iterations over keys of objects with index signatures will lose
 * type information about the keys and only the index signature will remain.
 * @internal
 */
export type WithoutIndexSignature<TObj> = {
  [K in keyof TObj as string extends K ? never : number extends K ? never : K]: TObj[K];
};

/**
 * @internal
 * Overwrite properties in `TType` with properties in `TWith`
 * Only overwrites properties when the type to be overwritten
 * is an object. Otherwise it will just use the type from `TWith`.
 */
export type Overwrite<TType, TWith> = TWith extends any
  ? TType extends object
    ? {
        [K in
          | keyof WithoutIndexSignature<TType>
          | keyof WithoutIndexSignature<TWith>]: K extends keyof TWith // Exclude index signature from keys
          ? TWith[K]
          : K extends keyof TType
          ? TType[K]
          : never;
      } & (string extends keyof TWith // Handle cases with an index signature
        ? { [key: string]: TWith[string] }
        : number extends keyof TWith
        ? { [key: number]: TWith[number] }
        : // eslint-disable-next-line @typescript-eslint/ban-types
          {})
    : TWith
  : never;

/** @internal */
export const contextMiddlewareMarker = "contextMiddlewareMarker" as "contextMiddlewareMarker" & {
  __brand: "contextMiddlewareMarker";
};
type ContextMiddlewareMarker = typeof contextMiddlewareMarker;

interface ContextMiddlewareResultBase {
  /**
   * All middlewares should pass through their `next()`'s output.
   * Requiring this marker makes sure that can't be forgotten at compile-time.
   */
  readonly marker: ContextMiddlewareMarker;
}

interface ContextMiddlewareOKResult<_TContextOverride> extends ContextMiddlewareResultBase {
  ok: true;
  data: unknown;
}

interface ContextMiddlewareErrorResult<_TContextOverride> extends ContextMiddlewareResultBase {
  ok: false;
  error: Error; // should be our error
}

/**
 * @internal
 */
export type ContextMiddlewareResult<_TContextOverride> =
  | ContextMiddlewareErrorResult<_TContextOverride>
  | ContextMiddlewareOKResult<_TContextOverride>;

export type ContextMiddlewareFunction<
  TContext,
  TContextOverridesIn,
  $ContextOverridesOut,
  TPayloadOut,
> = {
  (opts: {
    payload: TPayloadOut;
    ctx: Simplify<Overwrite<TContext, TContextOverridesIn>>;
    meta: RunMetadata;
    next: {
      (): Promise<ContextMiddlewareResult<TContextOverridesIn>>;
      <$ContextOverride>(ctx: $ContextOverride): Promise<ContextMiddlewareResult<$ContextOverride>>;
    };
  }): Promise<ContextMiddlewareResult<$ContextOverridesOut>>;
};

export const unsetMarker = Symbol("unsetMarker");
export type UnsetMarker = typeof unsetMarker;

export interface ContextBuilder<TContext, TContextOverrides, TPayloadOut = unknown> {
  use<$ContextOverridesOut>(
    fn: ContextMiddlewareFunction<TContext, TContextOverrides, $ContextOverridesOut, TPayloadOut>
  ): ContextBuilder<TContext, Overwrite<TContextOverrides, $ContextOverridesOut>, TPayloadOut>;
}

export type AnyContextBuilder = ContextBuilder<any, any, any>;

export function createContext<TContext, TParser extends Parser>(options?: {
  ctx?: TContext;
  payload?: TParser;
}): ContextBuilder<TContext, object, inferParserOut<TParser>> {
  const builder: AnyContextBuilder = {
    use(middlewareFn) {
      return {} as AnyContextBuilder;
    },
  };

  return builder;
}

export type TaskOptions<
  TOutput,
  TContext extends AnyContextBuilder,
  TIdentifier extends string,
  TParser extends Parser | undefined = undefined,
> = {
  /** An id for your task. This must be unique inside your project and not change between versions.  */
  id: TIdentifier;

  schema?: TParser;

  context?: TContext;

  /** This gets called when a task is triggered. It's where you put the code you want to execute.
   *
   * @param payload - The payload that is passed to your task when it's triggered. This must be JSON serializable.
   * @param params - Metadata about the run.
   */
  run: (params: Simplify<RunFnParams<inferParserOut<TParser>, TContext>>) => Promise<TOutput>;
};

export interface Task<
  TOutput,
  TIdentifier extends string,
  TParser extends Parser | undefined = undefined,
> {
  /**
   * The id of the task.
   */
  id: TIdentifier;
  /**
   * Trigger a task with the given payload, and continue without waiting for the result. If you want to wait for the result, use `triggerAndWait`. Returns the id of the triggered task run.
   * @param payload
   * @param options
   * @returns TriggerResult
   * - `id` - The id of the triggered task run.
   */
  trigger: (
    payload: Simplify<inferParserIn<TParser, any>>,
    options?: TriggerTaskOptions
  ) => Promise<TriggerResult>;

  /**
   * Trigger a task with the given payload, and wait for the result. Returns the result of the task run
   * @param payload
   * @param options - Options for the task run
   * @returns TaskRunResult
   * @example
   * ```
   * const result = await task.triggerAndWait({ foo: "bar" });
   *
   * if (result.ok) {
   *  console.log(result.output);
   * } else {
   *  console.error(result.error);
   * }
   * ```
   */
  triggerAndWait: (
    payload: Simplify<inferParserIn<TParser, any>>,
    options?: TriggerTaskOptions
  ) => Promise<TaskRunResult<TOutput>>;
}

export type AnyTask = Task<any, string, any>;

type inferParserIn<TParser extends Parser | undefined, TDefault = unknown> = TParser extends Parser
  ? inferParser<TParser>["in"]
  : TDefault;
type inferParserOut<TParser extends Parser | undefined, TDefault = unknown> = TParser extends Parser
  ? inferParser<TParser>["out"]
  : TDefault;

export type TaskPayloadIn<TTask extends AnyTask> = TTask extends Task<any, string, infer TParser>
  ? inferParserIn<TParser>
  : never;

export type TaskPayloadOut<TTask extends AnyTask> = TTask extends Task<any, string, infer TParser>
  ? inferParserOut<TParser>
  : never;

export type TaskOutput<TTask extends AnyTask> = TTask extends Task<infer TOutput, string, any>
  ? TOutput
  : never;

export type TaskIdentifier<TTask extends AnyTask> = TTask extends Task<any, infer TIdentifier, any>
  ? TIdentifier
  : never;

export type TaskTypes<TTask extends AnyTask> = TTask extends Task<
  infer TOutput,
  infer TIdentifier,
  infer TParser
>
  ? {
      id: TIdentifier;
      payloadIn: inferParserIn<TParser>;
      payloadOut: inferParserOut<TParser>;
      output: TOutput;
    }
  : never;

export type TriggerTaskOptions = {
  idempotencyKey?: string;
  maxAttempts?: number;
  startAt?: Date;
  startAfter?: number;
  concurrencyKey?: string;
};

export type Prettify<T> = {
  [K in keyof T]: T[K];
} & {};

export function task<
  TOutput,
  TContext extends AnyContextBuilder,
  TIdentifier extends string,
  TParser extends Parser | undefined = undefined,
>(
  options: TaskOptions<TOutput, TContext, TIdentifier, TParser>
): Task<TOutput, TIdentifier, TParser> {
  return createTask(options);
}

export function createTask<
  TOutput,
  TContext extends AnyContextBuilder,
  TIndentifier extends string,
  TParser extends Parser | undefined = undefined,
>(
  params: TaskOptions<TOutput, TContext, TIndentifier, TParser>
): Task<TOutput, TIndentifier, TParser> {
  const task: Task<TOutput, TIndentifier, TParser> = {
    id: params.id,
    trigger: async (payload, options) => {
      return {
        id: "run_1234",
      };
    },
    triggerAndWait: async (payload, options) => {
      const output = await params.run({
        meta: { run: "run_1234" },
        payload: payload as unknown as inferParserOut<TParser>, // Actually do the parsing
        ctx: {} as inferContext<TContext>,
      });

      return {
        ok: true,
        id: "run_1234",
        output,
      };
    },
  };

  return task;
}

export interface TaskLibraryRecord {
  [key: string]: AnyTask | TaskLibraryRecord;
}

export interface TaskLibrary<TRecord extends TaskLibraryRecord> {
  _def: { record: TRecord };
}

export type AnyTaskLibrary = TaskLibrary<any>;

export type CreateTaskLibraryOptions = {
  [key: string]: AnyTask | AnyTaskLibrary | CreateTaskLibraryOptions;
};

export type DecorateCreateTaskLibraryOptions<TTaskLibraryOptions extends CreateTaskLibraryOptions> =
  {
    [K in keyof TTaskLibraryOptions]: TTaskLibraryOptions[K] extends infer $Value
      ? $Value extends AnyTask
        ? $Value
        : $Value extends TaskLibrary<infer TRecord>
        ? TRecord
        : $Value extends CreateTaskLibraryOptions
        ? DecorateCreateTaskLibraryOptions<$Value>
        : never
      : never;
  };

function taskLibrary<TInput extends CreateTaskLibraryOptions>(
  input: TInput
): TaskLibrary<DecorateCreateTaskLibraryOptions<TInput>>;
function taskLibrary<TInput extends TaskLibraryRecord>(input: TInput): TaskLibrary<TInput>;
function taskLibrary(input: TaskLibraryRecord | CreateTaskLibraryOptions) {
  // TODO: reserved words

  return {
    _def: {
      record: input,
    },
  };
}

// ======== client side
type DecorateTask<TTask extends AnyTask> = {
  trigger: (id: TaskIdentifier<TTask>, payload: TaskPayloadIn<TTask>) => Promise<{ id: string }>;
};

type DecoratedTaskLibraryRecord<
  TTaskLibrary extends AnyTaskLibrary,
  TRecord extends TaskLibraryRecord,
> = {
  [TKey in keyof TRecord]: TRecord[TKey] extends infer $Value
    ? $Value extends TaskLibraryRecord
      ? DecoratedTaskLibraryRecord<TTaskLibrary, $Value>
      : $Value extends AnyTask
      ? DecorateTask<$Value>
      : never
    : never;
};

export type inferTaskLibraryClient<TTaskLibrary extends AnyTaskLibrary> =
  DecoratedTaskLibraryRecord<TTaskLibrary, TTaskLibrary["_def"]["record"]>;

export type CreateTriggerClient<TTaskLibrary extends AnyTaskLibrary> = {
  lib: inferTaskLibraryClient<TTaskLibrary>;
  runs: {
    retrieve: (id: string) => Promise<{ status: boolean }>;
  };
};

export type CreateTriggerClientOptions = {
  secretKey?: string;
};

export function createTriggerClient<TTaskLibrary extends AnyTaskLibrary>(
  options?: CreateTriggerClientOptions
): CreateTriggerClient<TTaskLibrary> {
  return {} as CreateTriggerClient<TTaskLibrary>;
}

// trigger/my-tasks.ts
// TODO: Support https://trpc.io/docs/server/middlewares#experimental-standalone-middlewares
const contextBuilder = createContext({ ctx: { foo: "bar" } });
const context = contextBuilder
  .use((opts) => {
    return opts.next({
      baz: "whatever",
    });
  })
  .use((opts) => {
    return opts.next({
      db: {
        find: async (id: string) => {
          return "hello";
        },
      },
    });
  });

const contextBuilder2 = createContext();

const contextBuilder3 = createContext({ ctx: { bar: "baz" } });

const contextBuilder4 = createContext().use((opts) => {
  return opts.next({
    hello: "world",
  });
});

const taskOne = task({
  id: "task-1",
  context,
  run: async () => {
    const handle = await taskTwo.trigger({ url: "https://trigger.dev" });
    const result = await taskTwo.triggerAndWait({ url: "https://trigger.dev" });

    return "foo-bar";
  },
});

const taskTwo = task({
  id: "task-2",
  async run(params) {
    return {
      hello: "world",
      // @ts-expect-error
      payload: params.payload.other,
    };
  },
});

const userTaskOne = task({
  id: "user/task-1",
  context: contextBuilder4,
  run: async (params) => {
    return "foo-bar";
  },
});

const userTaskTwo = task({
  id: "user/task-2",
  context: contextBuilder3,
  run: async (params) => {
    return "foo-bar";
  },
});

const zodTaskOne = task({
  id: "zod/task-1",
  context: contextBuilder,
  schema: z.object({ foo: z.string() }),
  run: async (params) => {},
});

const zodTaskTwo = task({
  id: "zod/task-2",
  schema: z.object({ foo: z.string(), isAdmin: z.boolean().default(false) }),
  context: contextBuilder2,
  run: async (params) => {
    console.log(params.payload.foo, params.meta.run);
  },
});

const contextWithPayloadSchema = createContext({ payload: z.object({ foo: z.string() }) }).use(
  (opts) => {
    return opts.next({
      bar: "baz",
    });
  }
);

const zodTaskThreeWithContext = task({
  id: "zod/task-2",
  schema: z.object({ foo: z.string(), isAdmin: z.boolean().default(false) }),
  context: contextWithPayloadSchema,
  run: async (params) => {
    console.log(params.payload.foo, params.meta.run);
  },
});

const zodTaskThreeWithoutMatchingPayload = task({
  id: "zod/task-2",
  schema: z.object({ bar: z.string() }),
  context: contextWithPayloadSchema,
  run: async (params) => {
    console.log(params.ctx.bar);
    console.log(params.payload.bar, params.meta.run);
  },
});

const valibotTaskOne = task({
  id: "valibot/task-1",
  schema: wrap(
    v.object({
      foo: v.string(),
    })
  ),
  run: async (params) => {
    await zodTaskOne.trigger({ foo: "bar" });
    await zodTaskTwo.trigger({ foo: "bar" });

    await valibotTaskTwo.trigger({ foo: "bar" });
  },
});

const valibotTaskTwo = task({
  id: "valibot/task-2",
  schema: wrap(
    v.object({
      foo: v.string(),
      isAdmin: v.optional(v.boolean(), true),
    })
  ),
  run: async (params) => {
    await valibotTaskOne.trigger({ foo: "bar" });
  },
});

// in trigger/lib.ts
const myTaskLibrary = taskLibrary({
  myTasks: { taskOne, taskTwo },
});

const userTaskLibrary = taskLibrary({
  userTaskOne,
  userTaskTwo,
});

const zodTaskLibrary = taskLibrary({
  zodTaskOne,
  zodTaskTwo,
});

const valibotTaskLibrary = taskLibrary({
  valibotTaskOne,
  valibotTaskTwo,
});

export const library = taskLibrary({
  foo: myTaskLibrary,
  bar: userTaskLibrary,
  zod: zodTaskLibrary,
  valibot: valibotTaskLibrary,
});

// Export the library type
export type Library = typeof library;

// Now on the client
const client = createTriggerClient<Library>({
  secretKey: "tr_dev_1234",
});

client.runs.retrieve("run_12343"); // Call regular API client calls

// Tasks are now available under lib
client.lib.foo.myTasks.taskOne.trigger("task-1", { hello: "world" });
client.lib.bar.userTaskOne.trigger("user/task-1", { userId: "user_123" });
client.lib.bar.userTaskTwo.trigger("user/task-2", {
  userId: "user_123",
  isAdmin: true,
});
client.lib.bar.userTaskTwo.trigger("user/task-2", {
  userId: "user_123",
  isAdmin: false,
});
client.lib.zod.zodTaskOne.trigger("zod/task-1", { foo: "bar" });
client.lib.zod.zodTaskTwo.trigger("zod/task-2", { foo: "bar" });
client.lib.zod.zodTaskTwo.trigger("zod/task-2", { foo: "bar", isAdmin: false });
client.lib.valibot.valibotTaskTwo.trigger("valibot/task-2", { foo: "bar" });
client.lib.valibot.valibotTaskTwo.trigger("valibot/task-2", {
  foo: "bar",
  isAdmin: true,
});

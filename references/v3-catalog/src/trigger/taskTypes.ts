import { task, schemaTask, type TaskPayload } from "@trigger.dev/sdk/v3";
import { z } from "zod";

export const task1 = task({
  id: "types/task-1",
  run: async (payload: { foo: string }) => {
    return { hello: "world" };
  },
});

export const zodTask = schemaTask({
  id: "types/zod",
  schema: z.object({
    bar: z.string(),
    baz: z.string().default("foo"),
  }),
  run: async (payload) => {
    console.log(payload.bar, payload.baz);
  },
});

type ZodPayload = TaskPayload<typeof zodTask>;

import * as yup from "yup";

export const yupTask = schemaTask({
  id: "types/yup",
  schema: yup.object({
    bar: yup.string().required(),
    baz: yup.string().default("foo"),
  }),
  run: async (payload) => {
    console.log(payload.bar, payload.baz);
  },
});

type YupPayload = TaskPayload<typeof yupTask>;

import { object, string } from "superstruct";

export const superstructTask = schemaTask({
  id: "types/superstruct",
  schema: object({
    bar: string(),
    baz: string(),
  }),
  run: async (payload) => {
    console.log(payload.bar, payload.baz);
  },
});

type SuperstructPayload = TaskPayload<typeof superstructTask>;

import { type } from "arktype";

export const arktypeTask = schemaTask({
  id: "types/arktype",
  schema: type({
    bar: "string",
    baz: "string",
  }).assert,
  run: async (payload) => {
    console.log(payload.bar, payload.baz);
  },
});

type ArktypePayload = TaskPayload<typeof arktypeTask>;

import * as Schema from "@effect/schema/Schema";

const effectSchemaParser = Schema.decodeUnknownSync(
  Schema.Struct({ bar: Schema.String, baz: Schema.String })
);

export const effectTask = schemaTask({
  id: "types/effect",
  schema: effectSchemaParser,
  run: async (payload) => {
    console.log(payload.bar, payload.baz);
  },
});

type EffectPayload = TaskPayload<typeof effectTask>;

import * as T from "runtypes";

export const runtypesTask = schemaTask({
  id: "types/runtypes",
  schema: T.Record({
    bar: T.String,
    baz: T.String,
  }),
  run: async (payload) => {
    console.log(payload.bar, payload.baz);
  },
});

type RuntypesPayload = TaskPayload<typeof runtypesTask>;

import * as v from "valibot";

const valibotParser = v.parser(
  v.object({
    bar: v.string(),
    baz: v.string(),
  })
);

export const valibotTask = schemaTask({
  id: "types/valibot",
  schema: valibotParser,
  run: async (payload) => {
    console.log(payload.bar, payload.baz);
  },
});

import { Type } from "@sinclair/typebox";
import { wrap } from "@typeschema/typebox";

export const typeboxTask = schemaTask({
  id: "types/typebox",
  schema: wrap(
    Type.Object({
      bar: Type.String(),
      baz: Type.String(),
    })
  ),
  run: async (payload) => {
    console.log(payload.bar, payload.baz);
  },
});

export const customParserTask = schemaTask({
  id: "types/custom-parser",
  schema: (data: unknown) => {
    // This is a custom parser, and should do actual parsing (not just casting)
    if (typeof data !== "object") {
      throw new Error("Invalid data");
    }

    const { bar, baz } = data as { bar: string; baz: string };

    return { bar, baz };
  },
  run: async (payload) => {
    console.log(payload.bar, payload.baz);
  },
});

type CustomParserPayload = TaskPayload<typeof customParserTask>;

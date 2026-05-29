import { streams, InferStreamType } from "@trigger.dev/sdk";

export const textStream = streams.define<string>({
  id: "text",
});

export const progressStream = streams.define<{ step: string; percent: number }>({
  id: "progress",
});

export const logStream = streams.define<string>({
  id: "logs",
});

export type TextStreamPart = InferStreamType<typeof textStream>;
export type ProgressStreamPart = InferStreamType<typeof progressStream>;
export type LogStreamPart = InferStreamType<typeof logStream>;

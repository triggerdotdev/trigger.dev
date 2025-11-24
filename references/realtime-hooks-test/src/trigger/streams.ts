import { streams } from "@trigger.dev/sdk";

export const textStream = streams.define<string>({
  id: "text",
});

export const dataStream = streams.define<{ step: number; data: string; timestamp: number }>({
  id: "data",
});

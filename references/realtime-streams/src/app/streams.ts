import { InferStreamType, streams } from "@trigger.dev/sdk";
import { UIMessageChunk } from "ai";

export const demoStream = streams.define<string>({
  id: "demo",
});

export type DemoStreamPart = InferStreamType<typeof demoStream>;

export const aiStream = streams.define<UIMessageChunk>({
  id: "ai",
});

import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";
import type * as ai from "ai";
import aiSdkMajors from "./ai-sdk-majors.json" with { type: "json" };

type DoStream = (
  options: LanguageModelV3CallOptions
) => Promise<{ stream: ReadableStream<LanguageModelV3StreamPart> }>;

type MockModel = new (options: { doStream: DoStream }) => LanguageModelV3;

/**
 * One installed AI SDK major, loaded from the package `test/ai-sdk-majors.json`
 * names. Every major is typed as the default one, so a test is written once:
 * the calls the tests make have the same shape on each.
 */
export type AiSdk = {
  major: number;
  streamText: typeof ai.streamText;
  tool: typeof ai.tool;
  stepCountIs: typeof ai.stepCountIs;
  simulateReadableStream: typeof ai.simulateReadableStream;
  mockModel: (doStream: DoStream) => LanguageModelV3;
};

async function load(major: number, pkg: string): Promise<AiSdk> {
  const sdk = (await import(pkg)) as typeof ai;
  const test = (await import(`${pkg}/test`)) as Record<string, MockModel | undefined>;
  // The newest mock model the major ships. A major that changes the stream
  // parts again fails here or in the tests, which is the point.
  const Mock = test.MockLanguageModelV4 ?? test.MockLanguageModelV3;
  if (!Mock) throw new Error(`${pkg}/test exports no mock language model this file knows`);
  return {
    major,
    streamText: sdk.streamText,
    tool: sdk.tool,
    stepCountIs: sdk.stepCountIs,
    simulateReadableStream: sdk.simulateReadableStream,
    mockModel: (doStream) => new Mock({ doStream }),
  };
}

/** Every AI SDK major the package's tests run against. */
export const aiSdks: AiSdk[] = await Promise.all(
  aiSdkMajors.tested.map(({ major, package: pkg }) => load(major, pkg))
);

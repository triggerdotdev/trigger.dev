import { logger, streams, task } from "@trigger.dev/sdk";
import { setTimeout } from "timers/promises";
import { textStream, progressStream, logStream } from "./streams.js";

// Test 1: .pipe() then read back from S2 via a coordinator
export const streamsPipeTask = task({
  id: "streams-pipe",
  run: async () => {
    const source = ReadableStream.from(generateChunks(5));
    const { waitUntilComplete } = textStream.pipe(source);
    await waitUntilComplete();

    return { written: 5 };
  },
});

export const streamsPipeReadTask = task({
  id: "streams-pipe-read",
  run: async () => {
    const handle = await streamsPipeTask.trigger({});

    const stream = await textStream.read(handle.id);
    const chunks: string[] = [];
    for await (const chunk of stream) {
      logger.info("read chunk from pipe", { chunk });
      chunks.push(chunk);
    }

    return { chunks };
  },
});

// Test 2: .append() then read back from S2
export const streamsAppendTask = task({
  id: "streams-append",
  run: async () => {
    await logStream.append("Starting processing");
    await progressStream.append({ step: "init", percent: 0 });

    await setTimeout(500);
    await logStream.append("Step 1 complete");
    await progressStream.append({ step: "step-1", percent: 33 });

    await setTimeout(500);
    await logStream.append("Step 2 complete");
    await progressStream.append({ step: "step-2", percent: 66 });

    await setTimeout(500);
    await logStream.append("All done");
    await progressStream.append({ step: "done", percent: 100 });

    return { success: true };
  },
});

export const streamsAppendReadTask = task({
  id: "streams-append-read",
  run: async () => {
    const handle = await streamsAppendTask.trigger({});

    // Read both log and progress streams from the child
    const logStreamReader = await logStream.read(handle.id);
    const logs: string[] = [];
    for await (const chunk of logStreamReader) {
      logger.info("read log", { chunk });
      logs.push(chunk);
    }

    const progressStreamReader = await progressStream.read(handle.id);
    const steps: Array<{ step: string; percent: number }> = [];
    for await (const chunk of progressStreamReader) {
      logger.info("read progress", { chunk });
      steps.push(chunk);
    }

    return { logs, steps };
  },
});

// Test 3: .writer() then read back
export const streamsWriterTask = task({
  id: "streams-writer",
  run: async () => {
    const { waitUntilComplete } = logStream.writer({
      execute: ({ write, merge }) => {
        write("Line 1 from write()");
        write("Line 2 from write()");

        const moreLines = ReadableStream.from(["Line 3 from merge()", "Line 4 from merge()"]);
        merge(moreLines);
      },
    });

    await waitUntilComplete();

    return { written: 4 };
  },
});

export const streamsWriterReadTask = task({
  id: "streams-writer-read",
  run: async () => {
    const handle = await streamsWriterTask.trigger({});

    const stream = await logStream.read(handle.id);
    const lines: string[] = [];
    for await (const chunk of stream) {
      logger.info("read writer line", { chunk });
      lines.push(chunk);
    }

    return { lines };
  },
});

// Test 4: Direct streams.pipe() then read back with streams.read()
export const streamsDirectPipeTask = task({
  id: "streams-direct-pipe",
  run: async () => {
    const source = ReadableStream.from(generateChunks(3));
    const { waitUntilComplete } = streams.pipe("direct-output", source);
    await waitUntilComplete();

    return { written: 3 };
  },
});

export const streamsDirectPipeReadTask = task({
  id: "streams-direct-pipe-read",
  run: async () => {
    const handle = await streamsDirectPipeTask.trigger({});

    const stream = await streams.read(handle.id, "direct-output");
    const chunks: string[] = [];
    for await (const chunk of stream) {
      logger.info("read direct pipe chunk", { chunk });
      chunks.push(chunk as string);
    }

    return { chunks };
  },
});

// Test 5: Direct streams.append() then read back
export const streamsDirectAppendTask = task({
  id: "streams-direct-append",
  run: async () => {
    await streams.append("direct-logs", "Log entry 1");
    await setTimeout(300);
    await streams.append("direct-logs", "Log entry 2");
    await setTimeout(300);
    await streams.append("direct-logs", "Log entry 3");

    return { written: 3 };
  },
});

export const streamsDirectAppendReadTask = task({
  id: "streams-direct-append-read",
  run: async () => {
    const handle = await streamsDirectAppendTask.trigger({});

    const stream = await streams.read(handle.id, "direct-logs");
    const entries: string[] = [];
    for await (const chunk of stream) {
      logger.info("read direct append entry", { chunk });
      entries.push(chunk as string);
    }

    return { entries };
  },
});

// Test 6: Multiple streams in one task, read all back
export const streamsMultiTask = task({
  id: "streams-multi",
  run: async () => {
    await logStream.append("Starting multi-stream test");
    await progressStream.append({ step: "start", percent: 0 });

    const source = ReadableStream.from(generateChunks(3));
    const { waitUntilComplete } = textStream.pipe(source);

    await setTimeout(500);
    await logStream.append("Text stream piped");
    await progressStream.append({ step: "piped", percent: 50 });

    await waitUntilComplete();

    await logStream.append("Complete");
    await progressStream.append({ step: "done", percent: 100 });

    return { success: true };
  },
});

export const streamsMultiReadTask = task({
  id: "streams-multi-read",
  run: async () => {
    const handle = await streamsMultiTask.trigger({});

    const logReader = await logStream.read(handle.id);
    const logs: string[] = [];
    for await (const chunk of logReader) {
      logs.push(chunk);
    }

    const progressReader = await progressStream.read(handle.id);
    const steps: Array<{ step: string; percent: number }> = [];
    for await (const chunk of progressReader) {
      steps.push(chunk);
    }

    const textReader = await textStream.read(handle.id);
    const texts: string[] = [];
    for await (const chunk of textReader) {
      texts.push(chunk);
    }

    return { logs, steps, texts };
  },
});

async function* generateChunks(count: number) {
  for (let i = 0; i < count; i++) {
    await setTimeout(200);
    yield `chunk-${i}`;
  }
}

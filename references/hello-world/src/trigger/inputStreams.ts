import { logger, runs, streams, task, wait } from "@trigger.dev/sdk/v3";

// Define typed input streams
const approvalStream = streams.input<{ approved: boolean; reviewer: string }>({
  id: "approval",
});

const messageStream = streams.input<{ text: string }>({ id: "messages" });

/**
 * Coordinator task that exercises all input stream patterns end-to-end.
 *
 * 1a. .once().unwrap() — trigger a child, send data, verify unwrap returns TData
 * 1b. .once() result  — trigger a child, send data, verify result object { ok, output }
 * 2.  .on()            — trigger a child, send it multiple messages, poll until complete
 * 3.  .wait()          — trigger a child, send it data (completes its waitpoint), poll until complete
 * 4.  .wait() race     — send data before child calls .wait(), verify race handling
 */
export const inputStreamCoordinator = task({
  id: "input-stream-coordinator",
  run: async () => {
    const results: Record<string, unknown> = {};

    // --- Test 1a: .once() with .unwrap() ---
    logger.info("Test 1a: .once().unwrap()");
    const onceUnwrapHandle = await inputStreamOnceUnwrap.trigger({});
    await wait.for({ seconds: 5 });
    await approvalStream.send(onceUnwrapHandle.id, { approved: true, reviewer: "coordinator-unwrap" });
    const onceUnwrapRun = await runs.poll(onceUnwrapHandle, { pollIntervalMs: 1000 });
    results.onceUnwrap = onceUnwrapRun.output;
    logger.info("Test 1a passed", { output: onceUnwrapRun.output });

    // --- Test 1b: .once() with result object ---
    logger.info("Test 1b: .once() result object");
    const onceResultHandle = await inputStreamOnceResult.trigger({});
    await wait.for({ seconds: 5 });
    await approvalStream.send(onceResultHandle.id, { approved: true, reviewer: "coordinator-result" });
    const onceResultRun = await runs.poll(onceResultHandle, { pollIntervalMs: 1000 });
    results.onceResult = onceResultRun.output;
    logger.info("Test 1b passed", { output: onceResultRun.output });

    // --- Test 2: .on() with multiple messages ---
    logger.info("Test 2: .on()");
    const onHandle = await inputStreamOn.trigger({ messageCount: 3 });
    await wait.for({ seconds: 5 });
    for (let i = 0; i < 3; i++) {
      await messageStream.send(onHandle.id, { text: `message-${i}` });
      await wait.for({ seconds: 1 });
    }
    const onRun = await runs.poll(onHandle, { pollIntervalMs: 1000 });
    results.on = onRun.output;
    logger.info("Test 2 passed", { output: onRun.output });

    // --- Test 3: .wait() (waitpoint-based) ---
    logger.info("Test 3: .wait()");
    const waitHandle = await inputStreamWait.trigger({ timeout: "1m" });
    await wait.for({ seconds: 5 });
    await approvalStream.send(waitHandle.id, { approved: true, reviewer: "coordinator-wait" });
    const waitRun = await runs.poll(waitHandle, { pollIntervalMs: 1000 });
    results.wait = waitRun.output;
    logger.info("Test 3 passed", { output: waitRun.output });

    // --- Test 4: .wait() race condition (send before child calls .wait()) ---
    logger.info("Test 4: .wait() race");
    const raceHandle = await inputStreamWait.trigger({ timeout: "1m" });
    await approvalStream.send(raceHandle.id, { approved: false, reviewer: "race-test" });
    const raceRun = await runs.poll(raceHandle, { pollIntervalMs: 1000 });
    results.race = raceRun.output;
    logger.info("Test 4 passed", { output: raceRun.output });

    logger.info("All input stream tests passed", { results });
    return results;
  },
});

/**
 * Uses .once().unwrap() — returns TData directly, throws InputStreamTimeoutError on timeout.
 */
export const inputStreamOnceUnwrap = task({
  id: "input-stream-once-unwrap",
  run: async (_payload: Record<string, never>) => {
    logger.info("Waiting for approval via .once().unwrap()");

    const approval = await approvalStream.once({ timeoutMs: 30_000 }).unwrap();

    logger.info("Received approval", { approval });
    return { approval };
  },
});

/**
 * Uses .once() with result object — check result.ok to handle timeout without try/catch.
 */
export const inputStreamOnceResult = task({
  id: "input-stream-once-result",
  run: async (_payload: Record<string, never>) => {
    logger.info("Waiting for approval via .once() result object");

    const result = await approvalStream.once({ timeoutMs: 30_000 });

    if (!result.ok) {
      logger.error("Timed out waiting for approval", { error: result.error.message });
      return { approval: null, timedOut: true };
    }

    logger.info("Received approval", { approval: result.output });
    return { approval: result.output };
  },
});

/**
 * Uses .on() to subscribe and collect multiple messages.
 */
export const inputStreamOn = task({
  id: "input-stream-on",
  run: async (payload: { messageCount?: number }) => {
    const expected = payload.messageCount ?? 3;
    const received: { text: string }[] = [];

    logger.info("Subscribing to messages via .on()", { expected });

    const { off } = messageStream.on((data) => {
      logger.info("Received message", { data });
      received.push(data);
    });

    while (received.length < expected) {
      await wait.for({ seconds: 1 });
    }

    off();
    logger.info("Done receiving messages", { count: received.length });
    return { messages: received };
  },
});

/**
 * Uses .wait() to suspend the task via a waitpoint until data arrives.
 */
export const inputStreamWait = task({
  id: "input-stream-wait",
  run: async (payload: { timeout?: string }) => {
    logger.info("Waiting for approval via .wait()");
    const approval = await approvalStream.wait({
      timeout: payload.timeout ?? "5m",
    });
    logger.info("Received approval via .wait()", { approval });
    return { approval };
  },
});

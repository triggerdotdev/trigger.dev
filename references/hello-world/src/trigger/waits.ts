import { logger, wait, task, retry } from "@trigger.dev/sdk/v3";

type Token = {
  status: "approved" | "pending" | "rejected";
};

export const waitToken = task({
  id: "wait-token",
  run: async ({
    completeBeforeWaiting = false,
    idempotencyKey,
    idempotencyKeyTTL,
    completionDelay,
  }: {
    completeBeforeWaiting?: boolean;
    idempotencyKey?: string;
    idempotencyKeyTTL?: string;
    completionDelay?: number;
  }) => {
    logger.log("Hello, world", { completeBeforeWaiting });

    const token = await wait.createToken({
      idempotencyKey,
      idempotencyKeyTTL,
      timeout: completionDelay ? undefined : new Date(Date.now() + 10_000),
    });
    logger.log("Token", token);

    const token2 = await wait.createToken({
      idempotencyKey,
      idempotencyKeyTTL,
      timeout: "10s",
    });
    logger.log("Token2", token2);

    if (completeBeforeWaiting) {
      await wait.completeToken<Token>(token.id, { status: "approved" });
      await wait.for({ seconds: 5 });
    } else {
      await completeWaitToken.trigger({ token: token.id, delay: completionDelay });
    }

    //wait for the token
    const result = await wait.forToken<{ foo: string }>(token);
    if (!result.ok) {
      logger.log("Token timeout", result);
    } else {
      logger.log("Token completed", result);
    }
  },
});

export const completeWaitToken = task({
  id: "wait-token-complete",
  run: async (payload: { token: string; delay?: number }) => {
    await wait.for({ seconds: payload.delay ?? 10 });
    await wait.completeToken<Token>(payload.token, { status: "approved" });
  },
});

export const waitForDuration = task({
  id: "wait-duration",
  run: async ({ duration = 4 }: { duration?: number }) => {
    await wait.for({ seconds: duration });
    await wait.until({ date: new Date(Date.now() + duration * 1000) });

    await retry.fetch("https://example.com/404/", { method: "GET" });

    await retry.onThrow(
      async () => {
        throw new Error("This is an error");
      },
      {
        maxAttempts: 2,
      }
    );
  },
});

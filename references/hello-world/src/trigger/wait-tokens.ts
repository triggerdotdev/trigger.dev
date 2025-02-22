import { logger, wait, task } from "@trigger.dev/sdk/v3";

type Token = {
  status: "approved" | "pending" | "rejected";
};

export const waitToken = task({
  id: "wait-token",
  run: async ({ completeBeforeWaiting = false, idempotencyKey, idempotencyKeyTTL }: { completeBeforeWaiting?: boolean, idempotencyKey?: string, idempotencyKeyTTL?: string },) => {
    logger.log("Hello, world", { completeBeforeWaiting });

    const token = await wait.createToken({
      idempotencyKey,
      idempotencyKeyTTL,
      timeout: new Date(Date.now() + 10_000),
    });
    logger.log("Token", token);

    const token2 = await wait.createToken({
      idempotencyKey,
      idempotencyKeyTTL,
      timeout: "10s" });
    logger.log("Token2", token2);

    if (completeBeforeWaiting) {
      await wait.completeToken<Token>(token.id, { status: "approved" });
      await wait.for({ seconds: 10 });
    } else {
      await completeWaitToken.trigger({ token: token.id, delay: 4 });
    }


    //wait for the token
    const result = await wait.forToken<{ foo: string }>(token);
    if (!result.ok) {
      logger.log("Token timeout", result);
    } else {
      logger.log("Token completed", result);
    }

  },
})

export const completeWaitToken = task({
  id: "wait-token-complete",
  run: async (payload: { token: string; delay: number }) => {
    await wait.for({ seconds: payload.delay });
    await wait.completeToken<Token>(payload.token, { status: "approved" });
  },
});

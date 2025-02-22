import { logger, wait, task } from "@trigger.dev/sdk/v3";

type Token = {
  status: "approved" | "pending" | "rejected";
};

export const waitToken = task({
  id: "wait-token",
  run: async (payload: any, { ctx }) => {
    logger.log("Hello, world", { payload });

    const idempotencyKey = "a";

    const token = await wait.createToken({
      // idempotencyKey,
      timeout: new Date(Date.now() + 5_000),
    });
    logger.log("Token", token);

    const token2 = await wait.createToken({
      // idempotencyKey,
      timeout: "10s" });
    logger.log("Token2", token2);

    //todo test with an already completed token
    await completeWaitToken.trigger({ token: token.id, delay: 4 });


    //wait for the token
    const result = await wait.forToken<{ foo: string }>(token);
    if (!result.ok) {

    }

    logger.log("Token completed", result);
  },
})

export const completeWaitToken = task({
  id: "wait-token-complete",
  run: async (payload: { token: string; delay: number }) => {
    await wait.for({ seconds: payload.delay });
    await wait.completeToken<Token>(payload.token, { status: "approved" });
  },
});

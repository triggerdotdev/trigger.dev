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
      idempotencyKey,
      timeout: new Date(Date.now() + 5_000),
    });
    logger.log("Token", token);

    const token2 = await wait.createToken({ idempotencyKey, timeout: "10s" });
    logger.log("Token2", token2);

    //complete the token
    const result = await wait.completeToken<Token>(token, { status: "approved" });
  },
});

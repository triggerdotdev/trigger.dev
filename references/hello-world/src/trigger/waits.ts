import { logger, wait, task, retry, idempotencyKeys, auth } from "@trigger.dev/sdk/v3";
import { z } from "zod";
type Token = {
  status: "approved" | "pending" | "rejected";
};

export const waitToken = task({
  id: "wait-token",
  run: async ({
    completeBeforeWaiting = false,
    completeWithPublicToken = false,
    idempotencyKey,
    idempotencyKeyTTL,
    completionDelay,
    timeout,
    tags,
  }: {
    completeBeforeWaiting?: boolean;
    completeWithPublicToken?: boolean;
    idempotencyKey?: string;
    idempotencyKeyTTL?: string;
    completionDelay?: number;
    timeout?: string;
    tags?: string[];
  }) => {
    logger.log("Hello, world", { completeBeforeWaiting });

    const token = await wait.createToken({
      idempotencyKey,
      idempotencyKeyTTL,
      timeout,
      tags,
    });
    logger.log("Token", token);

    const token2 = await wait.createToken({
      idempotencyKey,
      idempotencyKeyTTL,
      timeout: "10s",
      tags,
    });
    logger.log("Token2", token2);

    const publicAccessToken = await auth.createPublicToken({
      scopes: {
        write: {
          waitpoints: token.id,
        },
      },
      expirationTime: "1h",
    });

    if (completeBeforeWaiting) {
      if (completeWithPublicToken) {
        await auth.withAuth(
          {
            accessToken: token.publicAccessToken,
          },
          async () => {
            await wait.completeToken<Token>(token.id, { status: "approved" });
          }
        );
      } else {
        await wait.completeToken<Token>(token.id, { status: "approved" });
      }

      await wait.for({ seconds: 5 });
    } else {
      await completeWaitToken.trigger({ token: token.id, delay: completionDelay });
    }

    const tokens = await wait.listTokens();
    await logger.trace("Tokens", async () => {
      for await (const token of tokens) {
        logger.log("Token", token);
      }
    });

    const retrievedToken = await wait.retrieveToken(token.id);
    logger.log("Retrieved token", retrievedToken);

    //wait for the token
    const result = await wait.forToken<{ foo: string }>(token, { releaseConcurrency: true });
    if (!result.ok) {
      logger.log("Token timeout", result);
    } else {
      logger.log("Token completed", result);
    }

    const tokens2 = await wait.listTokens({ tags, status: ["COMPLETED"] });
    await logger.trace("Tokens2", async () => {
      for await (const token of tokens2) {
        logger.log("Token2", token);
      }
    });

    const retrievedToken2 = await wait.retrieveToken(token.id);
    logger.log("Retrieved token2", retrievedToken2);
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
  run: async ({
    duration = 4,
    idempotencyKey,
    idempotencyKeyTTL,
  }: {
    duration?: number;
    idempotencyKey?: string;
    idempotencyKeyTTL?: string;
  }) => {
    const idempotency = idempotencyKey ? await idempotencyKeys.create(idempotencyKey) : undefined;

    await wait.for({
      seconds: duration,
      idempotencyKey: idempotency,
      idempotencyKeyTTL,
      releaseConcurrency: true,
    });
    await wait.until({ date: new Date(Date.now() + duration * 1000) });

    await retry.fetch("https://example.com/404", { method: "GET" });

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

export const waitHttpCallback = task({
  id: "wait-http-callback",
  run: async () => {
    const result = await wait.forHttpCallback<{ foo: string }>(
      async (url) => {
        logger.log(`Wait for HTTP callback ${url}`);
      },
      {
        timeout: "60s",
      }
    );

    if (!result.ok) {
      logger.log("Wait for HTTP callback failed", { error: result.error });
    } else {
      logger.log("Wait for HTTP callback completed", result);
    }
  },
});

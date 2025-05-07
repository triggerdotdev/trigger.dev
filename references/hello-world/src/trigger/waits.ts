import { auth, idempotencyKeys, logger, retry, task, wait } from "@trigger.dev/sdk/v3";
import Replicate, { Prediction } from "replicate";
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
  retry: {
    maxAttempts: 1,
  },
  run: async () => {
    if (process.env.REPLICATE_API_KEY) {
      const replicate = new Replicate({
        auth: process.env.REPLICATE_API_KEY,
      });

      const { token, data } = await wait.createHttpCallback(
        async (url) => {
          //pass the provided URL to Replicate's webhook
          return replicate.predictions.create({
            version: "27b93a2413e7f36cd83da926f3656280b2931564ff050bf9575f1fdf9bcd7478",
            input: {
              prompt: "A painting of a cat by Any Warhol",
            },
            // pass the provided URL to Replicate's webhook, so they can "callback"
            webhook: url,
            webhook_events_filter: ["completed"],
          });
        },
        {
          timeout: "10m",
          tags: ["replicate"],
        }
      );
      logger.log("Create result", { token, data });

      const prediction = await wait.forToken<Prediction>(token);

      if (!prediction.ok) {
        throw new Error("Failed to create prediction");
      }

      logger.log("Prediction", prediction);

      const imageUrl = prediction.output.output;
      logger.log("Image URL", imageUrl);

      //same again but with unwrapping
      const result2 = await wait.forToken<Prediction>(token).unwrap();

      logger.log("Result2", { result2 });
    }
  },
});

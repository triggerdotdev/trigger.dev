import { InfisicalClient } from "@infisical/sdk";
import { sentryEsbuildPlugin } from "@sentry/esbuild-plugin";
import { OpenAIInstrumentation } from "@traceloop/instrumentation-openai";
import { esbuildPlugin } from "@trigger.dev/build";
import { audioWaveform } from "@trigger.dev/build/extensions/audioWaveform";
import { ffmpeg, syncEnvVars } from "@trigger.dev/build/extensions/core";
import { puppeteer } from "@trigger.dev/build/extensions/puppeteer";
import { prismaExtension } from "@trigger.dev/build/extensions/prisma";
import { emitDecoratorMetadata } from "@trigger.dev/build/extensions/typescript";
import { defineConfig } from "@trigger.dev/sdk/v3";

export { handleError } from "./src/handleError.js";

export default defineConfig({
  runtime: "node",
  project: "yubjwjsfkxnylobaqvqz",
  machine: "medium-1x",
  instrumentations: [new OpenAIInstrumentation()],
  additionalFiles: ["wrangler/wrangler.toml"],
  maxDuration: 3600,
  dirs: ["./src/trigger"],
  retries: {
    enabledInDev: false,
    default: {
      maxAttempts: 10,
      minTimeoutInMs: 5_000,
      maxTimeoutInMs: 30_000,
      factor: 2,
      randomize: true,
    },
  },
  enableConsoleLogging: false,
  logLevel: "info",
  onStart: async (payload, { ctx }) => {
    console.log(`Task ${ctx.task.id} started ${ctx.run.id}`);
  },
  onFailure: async (payload, error, { ctx }) => {
    console.log(
      `Task ${ctx.task.id} failed ${ctx.run.id}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  },
  build: {
    conditions: ["react-server"],
    extensions: [
      ffmpeg(),
      emitDecoratorMetadata(),
      audioWaveform(),
      prismaExtension({
        schema: "prisma/schema/schema.prisma",
        migrate: true,
        directUrlEnvVarName: "DATABASE_URL_UNPOOLED",
        clientGenerator: "client",
        typedSql: true,
      }),
      esbuildPlugin(
        sentryEsbuildPlugin({
          org: "triggerdev",
          project: "taskhero-examples-basic",
          authToken: process.env.SENTRY_AUTH_TOKEN,
        }),
        { placement: "last", target: "deploy" }
      ),
      syncEnvVars(async (ctx) => {
        if (
          !process.env.INFISICAL_CLIENT_ID ||
          !process.env.INFISICAL_CLIENT_SECRET ||
          !process.env.INFISICAL_PROJECT_ID
        ) {
          return;
        }

        const client = new InfisicalClient({
          clientId: process.env.INFISICAL_CLIENT_ID,
          clientSecret: process.env.INFISICAL_CLIENT_SECRET,
        });

        const secrets = await client.listSecrets({
          environment: ctx.environment,
          projectId: process.env.INFISICAL_PROJECT_ID,
        });

        return secrets.map((secret) => ({
          name: secret.secretKey,
          value: secret.secretValue,
        }));
      }),
      puppeteer(),
    ],
    external: ["re2"],
  },
});

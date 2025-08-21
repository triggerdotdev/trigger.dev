import { InfisicalClient } from "@infisical/sdk";
import { sentryEsbuildPlugin } from "@sentry/esbuild-plugin";
import { OpenAIInstrumentation } from "@traceloop/instrumentation-openai";
import { esbuildPlugin } from "@trigger.dev/build";
import { audioWaveform } from "@trigger.dev/build/extensions/audioWaveform";
import { additionalFiles, ffmpeg, syncEnvVars } from "@trigger.dev/build/extensions/core";
import { puppeteer } from "@trigger.dev/build/extensions/puppeteer";
import { playwright } from "@trigger.dev/build/extensions/playwright";
import { prismaExtension } from "@trigger.dev/build/extensions/prisma";
import { emitDecoratorMetadata } from "@trigger.dev/build/extensions/typescript";
import { defineConfig } from "@trigger.dev/sdk/v3";

export default defineConfig({
  runtime: "node",
  project: "yubjwjsfkxnylobaqvqz",
  machine: "medium-1x",
  instrumentations: [new OpenAIInstrumentation()],
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
  build: {
    conditions: ["react-server"],
    experimental_autoDetectExternal: true,
    experimental_keepNames: true,
    experimental_minify: true,
    extensions: [
      additionalFiles({
        files: ["./wrangler/wrangler.toml"],
      }),
      ffmpeg(),
      emitDecoratorMetadata(),
      audioWaveform(),
      prismaExtension({
        schema: "prisma",
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
          telemetry: false,
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
      playwright(),
    ],
    external: ["re2"],
  },
});

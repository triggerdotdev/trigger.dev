import { intro, isCancel, log, outro, password, select } from "@clack/prompts";
import type { ApiClient } from "@trigger.dev/core/v3";
import type { Command } from "commander";
import { z } from "zod";
import { commonOptions, handleTelemetry, wrapCommandAction } from "../../cli/common.js";
import { printInitialBanner } from "../../utilities/initialBanner.js";
import { resolveRunsClient, RunsCommonOptions, runsOptions } from "../runs/common.js";
import {
  DOTENV_FILES,
  prepareEnvFile,
  readEnvVariable,
  saveToEnvFile,
  saveToPrivateTempFile,
  trimSecret,
} from "./envFile.js";
import {
  DEFAULT_GRACE_PERIOD_SECONDS,
  GRACE_PERIOD_CHOICES,
  parseGracePeriod,
} from "./gracePeriod.js";

const DEFAULT_WRITE_FILE = ".env.local";
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const PREVIOUS_SECRET_TTL_HELP =
  "When replacing a secret, how long the old one keeps working: 0, or a duration up to 7d such as 1h or 24h. Asked for in a terminal; required in scripts when the endpoint already has a secret.";

const SetSecretOptions = RunsCommonOptions.extend({
  endpointId: z.string(),
  fromEnv: z.string().regex(ENV_NAME, "--from-env must be an environment variable name").optional(),
  fromFile: z.string().optional(),
  previousSecretTtl: z.string().optional(),
});

type SetSecretOptions = z.infer<typeof SetSecretOptions>;

const GenerateSecretOptions = RunsCommonOptions.extend({
  endpointId: z.string(),
  toEnv: z.string().regex(ENV_NAME, "--to-env must be an environment variable name").optional(),
  toFile: z.string().optional(),
  print: z.boolean().default(false),
  previousSecretTtl: z.string().optional(),
});

type GenerateSecretOptions = z.infer<typeof GenerateSecretOptions>;

export function configureWebhooksSetSecretCommand(webhooks: Command) {
  return commonOptions(
    runsOptions(
      webhooks
        .command("set-secret")
        .description(
          "Store the signing secret (or public key) a provider issued for a webhook endpoint, without printing it"
        )
        .argument("<endpoint>", "The endpoint's declared id or its wh_ id")
        .option(
          "--from-env <name>",
          "Read the secret from this environment variable, or from the project's .env files"
        )
        .option("--from-file <path>", "With --from-env, read the variable from this .env file only")
        .option("--previous-secret-ttl <duration>", PREVIOUS_SECRET_TTL_HELP)
    )
  ).action(async (endpointId, options) => {
    await handleTelemetry(async () => {
      await printInitialBanner(false, options.profile);
      await wrapCommandAction(
        "webhooksSetSecretCommand",
        SetSecretOptions,
        { ...options, endpointId },
        setSecret
      );
    });
  });
}

export function configureWebhooksGenerateSecretCommand(webhooks: Command) {
  return commonOptions(
    runsOptions(
      webhooks
        .command("generate-secret")
        .description(
          "Generate a new signing secret for a webhook endpoint and save it to an env file"
        )
        .argument("<endpoint>", "The endpoint's declared id or its wh_ id")
        .option("--to-env <name>", `Save the secret as this variable in ${DEFAULT_WRITE_FILE}`)
        .option(
          "--to-file <path>",
          `With --to-env, the .env file to save to (default ${DEFAULT_WRITE_FILE})`
        )
        .option("--print", "Print only the secret, for piping it into the provider's CLI")
        .option("--previous-secret-ttl <duration>", PREVIOUS_SECRET_TTL_HELP)
    )
  ).action(async (endpointId, options) => {
    await handleTelemetry(async () => {
      if (!options.print) await printInitialBanner(false, options.profile);
      await wrapCommandAction(
        "webhooksGenerateSecretCommand",
        GenerateSecretOptions,
        { ...options, endpointId },
        generateSecret
      );
    });
  });
}

async function setSecret(options: SetSecretOptions) {
  intro(`Setting the signing secret for ${options.endpointId}`);

  const flagGracePeriod = parseGracePeriodFlag(options.previousSecretTtl);
  const secret = await readSecret(options);
  const { apiClient, env } = await resolveRunsClient(options);
  const previousSecretTtlSeconds = await resolveGracePeriod(
    apiClient,
    options.endpointId,
    flagGracePeriod
  );

  const result = await apiClient.setWebhookEndpointSecret(options.endpointId, {
    secret,
    previousSecretTtlSeconds,
  });

  outro(
    `Stored the signing secret for ${result.id} in ${env}.${previousSecretNote(
      result.previousSecretExpiresAt
    )}`
  );
}

async function generateSecret(options: GenerateSecretOptions) {
  if (options.toEnv && options.print) {
    throw new Error("Pass either --to-env or --print, not both.");
  }

  if (options.toFile && !options.toEnv) {
    throw new Error("--to-file needs --to-env <name>.");
  }

  if (!options.toEnv && !options.print && !process.stdout.isTTY) {
    throw new Error(
      `Pass --to-env <name> to save the secret to ${DEFAULT_WRITE_FILE}, or --print to print it for piping. The secret isn't printed to a non-interactive output by default, so it stays out of logs and AI agent transcripts.`
    );
  }

  const flagGracePeriod = parseGracePeriodFlag(options.previousSecretTtl);
  const file = options.toFile ?? DEFAULT_WRITE_FILE;
  const destination = options.toEnv ? await prepareEnvFile(file) : undefined;

  const stdoutWrite = process.stdout.write.bind(process.stdout);
  if (options.print) {
    process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;
  }

  try {
    if (!options.print) intro(`Generating a signing secret for ${options.endpointId}`);

    const { apiClient, env } = await resolveRunsClient(options);
    const previousSecretTtlSeconds = await resolveGracePeriod(
      apiClient,
      options.endpointId,
      flagGracePeriod
    );
    const result = await apiClient.generateWebhookEndpointSecret(options.endpointId, {
      previousSecretTtlSeconds,
    });

    if (options.print) {
      stdoutWrite(`${result.secret}\n`);
      return;
    }

    const note = previousSecretNote(result.previousSecretExpiresAt);

    if (options.toEnv && destination) {
      let saved: { readableByOthers: boolean };
      try {
        saved = await saveToEnvFile(destination, options.toEnv, result.secret);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const rescue = await saveToPrivateTempFile(options.toEnv, result.secret).catch(
          () => undefined
        );
        throw new Error(
          rescue
            ? `Generated a new signing secret for ${result.id}, but couldn't save it to ${file} (${reason}). It's saved as ${options.toEnv} in ${rescue}, readable only by you. Move it into place, then delete that file.${note}`
            : `Generated a new signing secret for ${result.id}, but couldn't save it to ${file} or a temporary file (${reason}). Run the command again to generate another.${note}`
        );
      }

      if (saved.readableByOthers) {
        log.warn(`${file} is readable by other users on this machine. Run: chmod 600 ${file}`);
      }

      outro(
        `Generated a signing secret for ${result.id} in ${env} and saved it as ${options.toEnv} in ${file}.${note}`
      );
      return;
    }

    log.info(result.secret);
    outro(
      `Generated a signing secret for ${result.id} in ${env}. It's shown once; give it to the provider.${note}`
    );
  } finally {
    process.stdout.write = stdoutWrite as typeof process.stdout.write;
  }
}

function parseGracePeriodFlag(value: string | undefined): number | undefined {
  return value === undefined ? undefined : parseGracePeriod(value);
}

/**
 * How long the endpoint's current secret keeps working after it's replaced. An explicit flag wins;
 * otherwise a terminal asks, with the dashboard's choices, and a script must say, so replacing a
 * live secret never cuts the provider off by accident.
 */
async function resolveGracePeriod(
  apiClient: ApiClient,
  endpointId: string,
  flag: number | undefined
): Promise<number | undefined> {
  if (flag !== undefined) return flag;

  const endpoint = await apiClient.retrieveWebhookEndpoint(endpointId);
  if (!endpoint.secretSet) return undefined;

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      `${endpointId} already has a signing secret. Pass --previous-secret-ttl to say how long it keeps working: for example 24h while the provider switches to the new one, or 0 to stop it now if it leaked.`
    );
  }

  const choice = await select({
    message: `${endpointId} already has a signing secret. How long should it keep working?`,
    options: GRACE_PERIOD_CHOICES.map((c) => ({ ...c })),
    initialValue: DEFAULT_GRACE_PERIOD_SECONDS,
  });

  if (isCancel(choice)) {
    throw new Error("Cancelled.");
  }

  return choice;
}

async function readSecret(options: SetSecretOptions): Promise<string> {
  if (options.fromFile && !options.fromEnv) {
    throw new Error("--from-file needs --from-env <name>.");
  }

  if (options.fromEnv) {
    const value = await readEnvVariable(options.fromEnv, options.fromFile);
    if (!value) {
      throw new Error(
        options.fromFile
          ? `${options.fromEnv} isn't set in ${options.fromFile}.`
          : `${options.fromEnv} isn't set in the environment or in ${DOTENV_FILES.join(", ")}.`
      );
    }
    return value;
  }

  if (!process.stdin.isTTY) {
    const value = trimSecret(await readStdin());
    if (!value) {
      throw new Error("No secret on stdin. Pipe it in, or use --from-env <name>.");
    }
    return value;
  }

  const value = await password({
    message: "Paste the signing secret",
    validate: (input) => (input?.trim() ? undefined : "The secret can't be empty"),
  });

  if (isCancel(value)) {
    throw new Error("Cancelled.");
  }

  return value.trim();
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function previousSecretNote(expiresAt: string | Date | null | undefined): string {
  if (!expiresAt) return "";
  return ` The previous secret keeps working until ${new Date(expiresAt).toISOString()}.`;
}

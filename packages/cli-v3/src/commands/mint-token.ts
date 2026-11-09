import type { Command } from "commander";
import { z } from "zod";
import { CliApiClient } from "../apiClient.js";
import {
  CommonCommandOptions,
  commonOptions,
  handleTelemetry,
  wrapCommandAction,
} from "../cli/common.js";
import { CLI_LOGIN_EXPIRED_CODE, isLoggedIn, type LoginResult } from "../utilities/session.js";

const MintTokenCommandOptions = CommonCommandOptions.extend({
  ttl: z.coerce.number().int().positive().optional(),
  cap: z.string().optional(),
  client: z.string().optional(),
});

type MintTokenCommandOptions = z.infer<typeof MintTokenCommandOptions>;

export function configureMintTokenCommand(program: Command) {
  return commonOptions(
    program
      .command("mint-token")
      .description(
        "Mint a short-lived token (tr_uat_) that authenticates as you, from your stored personal access token"
      )
      .option("--ttl <seconds>", "Token lifetime in seconds (default 3600, max 604800)")
      .option(
        "--cap <scopes>",
        "Comma-separated scope cap, e.g. read:runs,read:tasks (omit for read-only: read:all)"
      )
      .option("--client <label>", "Attribution label recorded in the token (default: cli)")
  ).action(async (options) => {
    await handleTelemetry(async () => {
      await mintTokenCommand(options);
    });
  });
}

async function mintTokenCommand(options: unknown) {
  return await wrapCommandAction(
    "mintTokenCommand",
    MintTokenCommandOptions,
    options,
    async (opts) => {
      return await mintToken(opts);
    }
  );
}

async function mintToken(options: MintTokenCommandOptions) {
  const authentication = await isLoggedIn(options.profile);

  if (!authentication.ok) {
    throw new Error(notLoggedInMessage(authentication, options.profile));
  }

  const apiClient = new CliApiClient(authentication.auth.apiUrl, authentication.auth.accessToken);

  const cap = options.cap
    ?.split(",")
    .map((scope) => scope.trim())
    .filter(Boolean);

  const result = await apiClient.mintUserActorToken({
    ttlSeconds: options.ttl,
    cap: cap && cap.length > 0 ? cap : undefined,
    client: options.client ?? "cli",
  });

  if (!result.success) {
    throw new Error(`Failed to mint token: ${result.error}`);
  }

  // The token alone goes to stdout so it can be captured
  // (e.g. `UAT=$(trigger.dev mint-token)`); status goes to stderr.
  process.stderr.write(
    `Minted token for ${authentication.email} (expires in ${result.data.expiresInSeconds}s)\n`
  );
  if (options.ttl && result.data.expiresInSeconds < options.ttl) {
    process.stderr.write(
      "The lifetime was shortened so the token doesn't outlive your login or access token.\n"
    );
  }
  console.log(result.data.token);

  return result.data;
}

export function notLoggedInMessage(
  authentication: Extract<LoginResult, { ok: false }>,
  profile: string
) {
  if (authentication.error === "fetch failed") {
    return "Fetch failed. Platform down?";
  }
  // The server's message says why the login expired and how to log in again.
  if (authentication.errorCode === CLI_LOGIN_EXPIRED_CODE) {
    return authentication.error;
  }
  return `You must login first. Use \`trigger.dev login --profile ${profile}\` to login.`;
}

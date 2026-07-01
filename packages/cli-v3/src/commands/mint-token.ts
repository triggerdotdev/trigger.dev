import type { Command } from "commander";
import { z } from "zod";
import { CliApiClient } from "../apiClient.js";
import {
  CommonCommandOptions,
  commonOptions,
  handleTelemetry,
  wrapCommandAction,
} from "../cli/common.js";
import { isLoggedIn } from "../utilities/session.js";

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
      .option("--ttl <seconds>", "Token lifetime in seconds (default 3600, max 31536000)")
      .option(
        "--cap <scopes>",
        "Comma-separated scope cap, e.g. read:runs,read:tasks (defaults to your full role)"
      )
      .option("--client <label>", "Attribution label recorded in the token (default: cli)")
  ).action(async (options) => {
    await handleTelemetry(async () => {
      await mintTokenCommand(options);
    });
  });
}

export async function mintTokenCommand(options: unknown) {
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
    throw new Error(
      authentication.error === "fetch failed"
        ? "Fetch failed. Platform down?"
        : `You must login first. Use \`trigger.dev login --profile ${options.profile}\` to login.`
    );
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
  console.log(result.data.token);

  return result.data;
}

import type { Command } from "commander";
import {
  configureWebhooksGenerateSecretCommand,
  configureWebhooksSetSecretCommand,
} from "./secret.js";

export function configureWebhooksCommand(program: Command) {
  const webhooks = program
    .command("webhooks")
    .description("Manage the signing secrets of your hosted webhook endpoints");

  configureWebhooksSetSecretCommand(webhooks);
  configureWebhooksGenerateSecretCommand(webhooks);

  return webhooks;
}

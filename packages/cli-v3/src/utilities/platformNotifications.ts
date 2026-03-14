import { log } from "@clack/prompts";
import chalk from "chalk";
import { tryCatch } from "@trigger.dev/core/utils";
import { CliApiClient } from "../apiClient.js";
import { chalkGrey } from "./cliOutput.js";
import { evaluateDiscovery } from "./discoveryCheck.js";
import { logger } from "./logger.js";
import { spinner } from "./windows.js";

type CliLogLevel = "info" | "warn" | "error" | "success";

type PlatformNotification = {
  level: CliLogLevel;
  title: string;
  description: string;
  actionUrl?: string;
};

type FetchNotificationOptions = {
  apiClient: CliApiClient;
  projectRef?: string;
  projectRoot?: string;
};

export async function fetchPlatformNotification(
  options: FetchNotificationOptions
): Promise<PlatformNotification | undefined> {
  const [error, result] = await tryCatch(
    options.apiClient.getCliPlatformNotification(
      options.projectRef,
      AbortSignal.timeout(7000)
    )
  );

  if (error) {
    logger.debug("Platform notifications failed silently", { error });
    return undefined;
  }

  if (!result.success) {
    logger.debug("Platform notification fetch failed", { result });
    return undefined;
  }

  const notification = result.data.notification;
  if (!notification) return undefined;

  const { type, discovery, title, description, actionUrl } = notification.payload.data;

  if (discovery) {
    const root = options.projectRoot ?? process.cwd();
    const shouldShow = await evaluateDiscovery(discovery, root);
    if (!shouldShow) {
      logger.debug("Notification suppressed by discovery check", {
        notificationId: notification.id,
        discovery,
      });
      return undefined;
    }
  }

  return { level: type, title, description, actionUrl };
}

function displayPlatformNotification(
  notification: PlatformNotification | undefined
): void {
  if (!notification) return;

  const message = formatNotificationMessage(notification);
  log[notification.level](message);
}

function formatNotificationMessage(notification: PlatformNotification): string {
  const { title, description, actionUrl } = notification;
  const lines = [chalk.bold(title), chalkGrey(description)];
  if (actionUrl) {
    lines.push(chalk.underline(chalkGrey(actionUrl)));
  }
  return lines.join("\n");
}

const SPINNER_DELAY_MS = 200;

/**
 * Awaits a notification promise, showing a loading spinner if the fetch
 * takes longer than 200ms. The spinner is replaced by the notification
 * content, or removed cleanly if there's nothing to show.
 */
export async function awaitAndDisplayPlatformNotification(
  notificationPromise: Promise<PlatformNotification | undefined> | undefined
): Promise<void> {
  if (!notificationPromise) return;

  // Race against a short delay — if the promise resolves quickly, skip the spinner
  const pending = Symbol("pending");
  const raceResult = await Promise.race([
    notificationPromise,
    new Promise<typeof pending>((resolve) => setTimeout(() => resolve(pending), SPINNER_DELAY_MS)),
  ]);

  if (raceResult !== pending) {
    displayPlatformNotification(raceResult);
    return;
  }

  // Still pending after delay — show a spinner while waiting
  const $spinner = spinner();
  $spinner.start("Checking for notifications");
  const notification = await notificationPromise;

  if (notification) {
    $spinner.stop(formatNotificationMessage(notification));
  } else {
    $spinner.stop("No new notifications");
  }
}

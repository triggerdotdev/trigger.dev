import { triggerRunLocalStorage } from "./localStorage";
import type { TriggerCustomEvent } from "./types";
import fetch from "node-fetch";

export function sendEvent(
  idOrKey: string,
  event: TriggerCustomEvent
): Promise<void> {
  const triggerRun = triggerRunLocalStorage.getStore();

  if (!triggerRun) {
    // Do it through the API
    return sendEventFetch(idOrKey, event);
  }

  return triggerRun.sendEvent(idOrKey, event);
}

async function sendEventFetch(
  id: string,
  event: TriggerCustomEvent
): Promise<void> {
  if (!process.env.TRIGGER_API_KEY) {
    throw new Error(
      `There was a problem sending a custom event: the TRIGGER_API_KEY environment variable is not set`
    );
  }

  const baseUrl = process.env.TRIGGER_API_URL || "https://app.trigger.dev";
  const url = `${baseUrl}/api/v1/events`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.TRIGGER_API_KEY}`,
    },
    body: JSON.stringify({
      id,
      event,
    }),
  });

  if (!response.ok) {
    throw new Error(
      `There was a problem sending a custom event: ${response.statusText}`
    );
  }

  return;
}

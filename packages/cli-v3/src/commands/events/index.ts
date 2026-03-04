import { Command } from "commander";
import { configureEventsDlqCommand } from "./dlq.js";
import { configureEventsHistoryCommand } from "./history.js";
import { configureEventsListCommand } from "./list.js";
import { configureEventsPublishCommand } from "./publish.js";
import { configureEventsReplayCommand } from "./replay.js";

export function configureEventsCommand(program: Command) {
  const events = program
    .command("events")
    .description("Manage pub/sub events");

  configureEventsListCommand(events);
  configureEventsPublishCommand(events);
  configureEventsHistoryCommand(events);
  configureEventsReplayCommand(events);
  configureEventsDlqCommand(events);

  return events;
}

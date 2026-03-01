import { Command } from "commander";
import { configureEventsListCommand } from "./list.js";
import { configureEventsPublishCommand } from "./publish.js";

export function configureEventsCommand(program: Command) {
  const events = program
    .command("events")
    .description("Manage pub/sub events");

  configureEventsListCommand(events);
  configureEventsPublishCommand(events);

  return events;
}

import { env } from "~/env.server";
import { eventRepository } from "./eventRepository.server";
import { clickhouseEventRepository } from "./clickhouseEventRepositoryInstance.server";
import { IEventRepository } from "./eventRepository.types";

export function resolveEventRepositoryForStore(store: string | undefined): IEventRepository {
  const taskEventStore = store ?? env.EVENT_REPOSITORY_DEFAULT_STORE;

  if (taskEventStore === "clickhouse") {
    return clickhouseEventRepository;
  }

  return eventRepository;
}

/** The most endpoint ids a live poll carries in its URL. The route reads no more than this. */
export const MAX_LIVE_ENDPOINT_IDS = 100;

/** New deliveries are counted on every second poll tick, about every 6 seconds. */
const COUNT_EVERY_TICKS = 2;
/** When the server has to look the task's endpoints up first: about every 30 seconds. */
const COUNT_EVERY_TICKS_WITH_LOOKUP = 10;

export type LiveCountScope =
  /** Nothing can arrive: the page's endpoint list is empty. */
  | { kind: "none" }
  /** Every endpoint in the environment (the cross-endpoint deliveries list). */
  | { kind: "environment"; everyTicks: number }
  /** The endpoints the page already loaded, sent with the poll. */
  | { kind: "endpoints"; ids: string; everyTicks: number }
  /** A webhook task with more endpoints than fit in a URL: the server looks them up. */
  | { kind: "task"; slug: string; everyTicks: number };

/**
 * Which deliveries a page's live poll counts, and how often. A page that knows its endpoints sends
 * their ids, so the poll costs no endpoint lookup. Only a task subscribed to more endpoints than a
 * URL holds asks the server to find them, and then less often: that lookup reads every endpoint
 * in the environment.
 */
export function liveCountScope({
  webhookEndpointIds,
  webhookTaskSlug,
}: {
  webhookEndpointIds?: string[];
  webhookTaskSlug?: string;
}): LiveCountScope {
  if (webhookEndpointIds === undefined) {
    return webhookTaskSlug
      ? { kind: "task", slug: webhookTaskSlug, everyTicks: COUNT_EVERY_TICKS_WITH_LOOKUP }
      : { kind: "environment", everyTicks: COUNT_EVERY_TICKS };
  }
  if (webhookEndpointIds.length === 0) return { kind: "none" };
  if (webhookTaskSlug && webhookEndpointIds.length > MAX_LIVE_ENDPOINT_IDS) {
    return { kind: "task", slug: webhookTaskSlug, everyTicks: COUNT_EVERY_TICKS_WITH_LOOKUP };
  }
  return { kind: "endpoints", ids: webhookEndpointIds.join(","), everyTicks: COUNT_EVERY_TICKS };
}

/** The first tick counts, so a page that just loaded hears about arrivals at once. */
export function isLiveCountTick(tick: number, everyTicks: number) {
  return tick === 1 || tick % everyTicks === 0;
}

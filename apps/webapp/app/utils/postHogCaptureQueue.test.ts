import { expect, it } from "vitest";
import { PostHogCaptureQueue } from "./postHogCaptureQueue";

it("sends early custom events once PostHog is ready, in order", () => {
  const sent: unknown[] = [];
  const queue = new PostHogCaptureQueue((event, properties) => sent.push({ event, properties }));
  queue.capture("logs_search_started", { search_id: "one" });
  expect(sent).toEqual([]);
  queue.ready();
  queue.ready();
  queue.capture("logs_search_result", { outcome: "results" });
  expect(sent).toEqual([
    { event: "logs_search_started", properties: { search_id: "one" } },
    { event: "logs_search_result", properties: { outcome: "results" } },
  ]);
});

it("drops pending and future events when analytics is disabled", () => {
  const sent: string[] = [];
  const queue = new PostHogCaptureQueue((event) => sent.push(event));
  queue.capture("before");
  queue.disable();
  queue.capture("after");
  queue.ready();
  expect(sent).toEqual([]);
});

it("bounds the initialization queue when the SDK never loads", () => {
  const sent: string[] = [];
  const queue = new PostHogCaptureQueue((event) => sent.push(event));
  for (let i = 0; i < 1000; i++) queue.capture("event");
  queue.ready();
  expect(sent.length).toBeGreaterThan(0);
  expect(sent.length).toBeLessThan(1000);
});

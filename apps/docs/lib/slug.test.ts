import { assert, test } from "vitest";
import { headingSlug, headingSlugger, headingText, redirectTarget } from "./slug.ts";

// Pairs taken from the ids the previous docs site served (Nov 2026).
test("heading ids match the previous site", () => {
  const live: [string, string][] = [
    ["chat.agent()", "chat-agent"],
    ["Simple: return a StreamTextResult", "simple-return-a-streamtextresult"],
    ["Records on session.out", "records-on-session-out"],
    [
      "X-Peek-Settled / X-Session-Settled — opt-in fast close on idle reconnects",
      "x-peek-settled-/-x-session-settled-—-opt-in-fast-close-on-idle-reconnects",
    ],
    ["Path B — Snapshot + replay (default)", "path-b-—-snapshot-+-replay-default"],
    ["Snapshot key & lifecycle", "snapshot-key-&-lifecycle"],
    ["AI helpers (ai from @trigger.dev/sdk/ai)", "ai-helpers-ai-from-@trigger-dev/sdk/ai"],
    ["Change a key's access", "change-a-key’s-access"],
    ["Pre-4.1.0 streams (legacy)", "pre-4-1-0-streams-legacy"],
  ];
  for (const [text, id] of live) assert.equal(headingSlug(text), id);
});

test("repeated headings get -2, -3", () => {
  const slug = headingSlugger();
  assert.deepEqual(["Testing your task", "Testing your task", "Testing your task"].map(slug), [
    "testing-your-task",
    "testing-your-task-2",
    "testing-your-task-3",
  ]);
});

test("heading text drops markup but keeps literal underscores", () => {
  assert.equal(
    headingText("`max_duration` and [links](/x) **bold**"),
    "max_duration and links bold"
  );
});

// Catches: MCP and Ask AI answering "no page" for an old path the site itself redirects.
test("old page paths follow docs.json redirects", () => {
  const redirects = [
    { source: "/queue-concurrency", destination: "/concurrency" },
    { source: "/concurrency-old", destination: "/queue-concurrency" },
    { source: "/v3/:slug*", destination: "/:slug*" },
    { source: "/v3/feature-matrix", destination: "https://feedback.trigger.dev/roadmap" },
  ];
  assert.equal(redirectTarget("/queue-concurrency", redirects), "/concurrency");
  assert.equal(redirectTarget("/concurrency-old", redirects), "/concurrency");
  assert.equal(redirectTarget("/v3/tasks/overview", redirects), "/tasks/overview");
  assert.equal(redirectTarget("/tasks/overview", redirects), undefined);
});

import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import App, { SUGGESTED_PROMPT } from "./App";
import { draftFor, keyFor, writeEditor } from "./editorState";
import type { Board, Job } from "../shared/types";

beforeEach(() => {
  const values = new Map<string, string>([["convex-image-processing-session", "a".repeat(64)]]);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

function cachedJob(overrides: Partial<Job> = {}): Job {
  return {
    id: "previous-edit",
    sample: "forest",
    prompt: SUGGESTED_PROMPT,
    preset: "balanced",
    createdAt: 1,
    expiresAt: Date.now() + 60_000,
    status: "COMPLETED",
    syncStatus: "complete",
    progress: 100,
    stage: "Images ready",
    runId: null,
    error: null,
    results: [
      {
        kind: "hero",
        width: 1024,
        height: 768,
        bytes: 100,
        format: "avif",
        url: "blob:previous-result",
      },
    ],
    ...overrides,
  };
}
function render(job: Job, quota: Partial<Board["quota"]> = {}) {
  const board: Board = {
    jobs: [job],
    turnstileSiteKey: null,
    quota: {
      used: 1,
      limit: 500,
      dailyUsed: 1,
      dailyLimit: 50,
      active: false,
      enabled: true,
      cooldownUntil: 0,
      ...quota,
    },
  };
  return renderToStaticMarkup(<App board={board} connected />);
}

test.each([
  { sample: "architecture" as const },
  { prompt: "Make this a sunny desert" },
  { preset: "quality" as const },
])("does not display a cached result for different inputs: %j", (mismatch) => {
  expect(render(cachedJob(mismatch))).not.toContain("blob:previous-result");
});

test("keeps the submit button disabled while the matching edit is running", () => {
  const html = render(cachedJob({ status: "EXECUTING", progress: 25, results: [] }));
  const submit = html.match(/<button[^>]*type="submit"[^>]*>.*?<\/button>/)?.[0];
  expect(submit).toBeDefined();
  expect(submit).toContain('disabled=""');
  expect(submit).toContain(">Submit</button>");
});

test("explains why another visitor’s active edit disables submission", () => {
  expect(render(cachedJob(), { active: true })).toContain(
    "Another edit is running. Please try again shortly."
  );
});

test("does not silently select a previous result matching the current draft", () => {
  writeEditor("a".repeat(64), { draft: draftFor(cachedJob()), selection: null });
  expect(render(cachedJob())).not.toContain('src="blob:previous-result"');
});

test("restores an explicitly selected result and explains where it came from", () => {
  const job = cachedJob();
  writeEditor("a".repeat(64), {
    draft: draftFor(job),
    selection: { key: keyFor(job), id: job.id },
  });
  const html = render(job);
  expect(html).toContain('src="blob:previous-result"');
  expect(html).toContain("Restored your last edit.");
});

test("restores an owned active edit instead of the default photo and prompt", () => {
  const job = cachedJob({
    sample: "coast",
    prompt: "Make the waves golden",
    status: "EXECUTING",
    results: [],
  });
  const html = render(job);
  expect(html).toContain("Coast original photograph");
  expect(html).toContain("Make the waves golden");
  expect(html).toContain("Your edit is running. You can leave and return.");
});

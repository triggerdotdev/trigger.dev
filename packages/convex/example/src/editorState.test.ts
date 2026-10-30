import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { draftFor, emptyEditor, keyFor, readEditor, selectedJob, writeEditor } from "./editorState";
import type { Job } from "../shared/types";

const OWNER = "a".repeat(64);
const job: Job = {
  id: "new-edit",
  requestId: "submitted-request",
  sample: "coast",
  preset: "balanced",
  prompt: "Turn the waves gold",
  createdAt: 1,
  expiresAt: Date.now() + 60_000,
  status: "EXECUTING",
  syncStatus: "polling",
  progress: 25,
  stage: "Editing",
  runId: "run-example",
  error: null,
  results: [],
};
beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

test("reload preserves the exact photo, prompt, and selected background job", () => {
  const editor = { draft: draftFor(job), selection: { key: keyFor(job), id: job.id } };
  writeEditor(OWNER, editor);
  expect(readEditor(OWNER)).toEqual(editor);
  expect(selectedJob(readEditor(OWNER), [job])?.id).toBe(job.id);
});

test("reload before the submission response finds its job by request ID, not old matching inputs", () => {
  writeEditor(OWNER, {
    draft: draftFor(job),
    selection: { key: keyFor(job), requestId: job.requestId },
  });
  const old = { ...job, id: "old-edit", requestId: "old-request", status: "COMPLETED" };
  expect(selectedJob(readEditor(OWNER), [old])).toBeUndefined();
  expect(selectedJob(readEditor(OWNER), [old, job])?.id).toBe(job.id);
  expect(selectedJob(readEditor(OWNER), [{ ...job, status: "COMPLETED" }])?.id).toBe(job.id);
});

test("a new browser session does not inherit another session's saved editor", () => {
  writeEditor(OWNER, { draft: draftFor(job), selection: { key: keyFor(job), id: job.id } });
  expect(readEditor("b".repeat(64))).toEqual(emptyEditor());
});

test("edited inputs never display the previously selected result", () => {
  const editor = {
    draft: { ...draftFor(job), prompt: "A different edit" },
    selection: { key: keyFor(job), id: job.id },
  };
  expect(selectedJob(editor, [job])).toBeUndefined();
});

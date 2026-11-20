import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach } from "vitest";
import { aiSdkMajors } from "./aiSdkMajors.js";

/**
 * Loaded in every non-default AI SDK major's vitest project. Runs the tests
 * `ai-sdk-majors.json` lists under `knownFailures` for that major as expected
 * failures: they pass the run while they still fail, and fail it once they
 * pass, so a fixed entry has to leave the list. On the default major they run
 * as usual, and any unlisted test that fails on this major fails the run.
 */
const major = Number(process.env.AI_SDK_MAJOR);
const root = fileURLToPath(new URL("..", import.meta.url));
const known = aiSdkMajors.knownFailures.filter((entry) => entry.major === major);

type Named = { name: string; suite?: Named; filepath?: string };

/** `describe > … > it` names, without the file-level suite (named after its path). */
const fullName = (task: Named) => {
  const names: string[] = [];
  for (let t: Named | undefined = task; t && t.filepath === undefined; t = t.suite) {
    if (t.name) names.unshift(t.name);
  }
  return names.join(" > ");
};

beforeEach((context) => {
  const file = relative(root, context.task.file.filepath);
  const name = fullName(context.task);
  // `fails` is what `it.fails` sets; vitest types it read-only but reads it
  // after the test body, so setting it here marks the test as expected to fail.
  if (known.some((entry) => entry.file === file && entry.test === name)) {
    (context.task as { fails?: boolean }).fails = true;
  }
});

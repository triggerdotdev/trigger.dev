import { PRESETS, PROMPT_LIMIT, SAMPLES } from "../shared/catalog";
import type { Job } from "../shared/types";

export type Draft = Pick<Job, "sample" | "preset" | "prompt">;
export type Selection = { key: string; id?: string; requestId?: string };
export type EditorState = { draft: Draft; selection: Selection | null };
const STORAGE_KEY = "convex-image-processing-editor";

export const keyFor = (draft: Draft) =>
  JSON.stringify([draft.sample, draft.preset, draft.prompt.trim()]);
export const draftFor = ({ sample, preset, prompt }: Draft): Draft => ({ sample, preset, prompt });
export const emptyEditor = (): EditorState => ({
  draft: { sample: SAMPLES[0]!.id, preset: "balanced", prompt: "" },
  selection: null,
});

export function readEditor(sessionToken: string): EditorState {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    const draft = saved?.draft;
    if (
      saved?.sessionToken !== sessionToken ||
      !SAMPLES.some((sample) => sample.id === draft?.sample) ||
      !PRESETS.some((preset) => preset.id === draft?.preset) ||
      typeof draft?.prompt !== "string" ||
      draft.prompt.length > PROMPT_LIMIT
    )
      return emptyEditor();
    const selection = saved.selection;
    return {
      draft: draftFor(draft),
      selection:
        selection?.key === keyFor(draft) &&
        (typeof selection.id === "string" || typeof selection.requestId === "string")
          ? {
              key: selection.key,
              id: typeof selection.id === "string" ? selection.id : undefined,
              requestId: typeof selection.requestId === "string" ? selection.requestId : undefined,
            }
          : null,
    };
  } catch {
    return emptyEditor();
  }
}

export function writeEditor(sessionToken: string, editor: EditorState): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ sessionToken, ...editor }));
    return true;
  } catch {
    return false;
  }
}

export function selectedJob(editor: EditorState, jobs: Job[]): Job | undefined {
  const selected = editor.selection;
  if (!selected || selected.key !== keyFor(editor.draft)) return undefined;
  return jobs.find(
    (job) =>
      keyFor(job) === selected.key &&
      (selected.id
        ? job.id === selected.id
        : !!selected.requestId && job.requestId === selected.requestId)
  );
}

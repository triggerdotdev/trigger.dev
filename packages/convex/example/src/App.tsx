import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PROMPT_LIMIT, SAMPLES } from "../shared/catalog";
import type { Board, PresetId, SampleId, Job } from "../shared/types";
import { usePrivateHistory } from "./usePrivateHistory";
import { ImagePicker } from "./ImagePicker";
import { JobPanel, jobFinished } from "./JobPanel";
import {
  draftFor,
  emptyEditor,
  keyFor,
  readEditor,
  selectedJob,
  writeEditor,
  type Draft,
  type EditorState,
} from "./editorState";

export type ProcessImages = (args: {
  sample: SampleId;
  preset: PresetId;
  prompt: string;
  requestId: string;
  sessionToken: string;
  challengeToken?: string;
}) => Promise<{ jobId: string; cached: boolean }>;
type AppProps = {
  board?: Board;
  processImages?: ProcessImages;
  connected?: boolean;
  preview?: boolean;
  connectionError?: boolean;
  JobView?: React.ComponentType<{
    job?: Job;
    pending: boolean;
    preview: boolean;
    sessionToken: string;
    onLoad: (job: Job) => Promise<void>;
  }>;
};
const DEFAULT_PRESET = "balanced";
export const SUGGESTED_PROMPT =
  "Turn this into a cinematic winter scene with cool blue light and gentle falling snow.";

type Turnstile = {
  render: (element: HTMLElement, options: Record<string, unknown>) => string;
  reset: (id?: string) => void;
  remove: (id: string) => void;
};
declare global {
  interface Window {
    turnstile?: Turnstile;
  }
}

export function getSessionToken(): string {
  const key = "convex-image-processing-session";
  let token = localStorage.getItem(key);
  if (!token) {
    token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
      byte.toString(16).padStart(2, "0")
    ).join("");
    localStorage.setItem(key, token);
  }
  return token;
}

export default function App({
  board,
  processImages,
  connected = false,
  preview = false,
  connectionError = false,
  JobView = JobPanel,
}: AppProps) {
  const token = useMemo(() => (preview ? "" : getSessionToken()), [preview]);
  const initialEditor = useMemo(
    () => (preview ? emptyEditor() : readEditor(token)),
    [preview, token]
  );
  const [editor, setEditor] = useState(initialEditor);
  const editorRef = useRef(editor);
  editorRef.current = editor;
  const [restored, setRestored] = useState(
    !!initialEditor.selection || !!initialEditor.draft.prompt
  );
  const [storageError, setStorageError] = useState<string | null>(null);
  const persistEditor = useCallback(
    (next: EditorState) => {
      editorRef.current = next;
      setEditor(next);
      if (!preview)
        setStorageError(
          writeEditor(token, next)
            ? null
            : "This browser could not save your draft. Running edits can still be restored from Convex."
        );
    },
    [preview, token]
  );
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [challengeToken, setChallengeToken] = useState<string>();
  const [now, setNow] = useState(Date.now);
  const submitting = useRef(false);
  const widget = useRef<HTMLDivElement>(null);
  const resultSection = useRef<HTMLDivElement>(null);
  const history = usePrivateHistory(token);
  const { jobs: cachedJobs, download } = history;
  const remoteJobs = board?.jobs ?? [];
  const jobMap = new Map(remoteJobs.map((job) => [job.id, job]));
  for (const local of history.jobs) jobMap.set(local.id, local);
  const jobs = [...jobMap.values()].sort((a, b) => b.createdAt - a.createdAt);
  const activeJob = remoteJobs.find((job) => !jobFinished(job));
  const job = activeJob ?? selectedJob(editor, jobs);
  const draft = activeJob ? draftFor(activeJob) : editor.draft;
  const reusable = job && (!jobFinished(job) || !!job.results.length);
  const editing = !!job && !jobFinished(job);
  const busy = pending || editing;

  useEffect(() => {
    if (
      !activeJob ||
      (editorRef.current.selection?.id === activeJob.id &&
        keyFor(editorRef.current.draft) === keyFor(activeJob))
    )
      return;
    persistEditor({
      draft: draftFor(activeJob),
      selection: { key: keyFor(activeJob), id: activeJob.id, requestId: activeJob.requestId },
    });
    if (!submitting.current) setRestored(true);
  }, [activeJob, persistEditor]);
  const quota = board?.quota;
  const cooldown = Math.max(0, Math.ceil(((quota?.cooldownUntil ?? 0) - now) / 1000));
  function submissionDisabledReason(): string | null {
    if (pending) return "Submitting your edit…";
    if (editing)
      return (
        job.error ??
        (restored
          ? "Your in-progress edit was restored. You can leave and return."
          : "Your edit is running. You can leave and return.")
      );
    if (reusable) return null;
    if (preview) return "This is a read-only preview.";
    if (!connected || !board) return "Connecting to Convex…";
    if (!quota?.enabled) return "Image editing is paused.";
    if (quota.used >= quota.limit) return "The demo has reached its generation limit.";
    if (quota.dailyUsed >= quota.dailyLimit)
      return "Today's demo allowance has been used. Try again tomorrow.";
    if (quota.active) return "Another edit is running. Please try again shortly.";
    if (cooldown > 0) return `Ready for another edit in ${cooldown}s.`;
    if (!draft.prompt.trim()) return "Describe your edit before submitting.";
    if (draft.prompt.length > PROMPT_LIMIT)
      return `Keep your edit within ${PROMPT_LIMIT} characters.`;
    if (board.turnstileSiteKey && !challengeToken) return "Complete human verification to submit.";
    return null;
  }
  const disabledReason = submissionDisabledReason();
  const disabled = disabledReason !== null;
  const photograph = SAMPLES.find((sample) => sample.id === draft.sample)!;

  useEffect(() => {
    if (!quota?.cooldownUntil || quota.cooldownUntil <= Date.now()) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [quota?.cooldownUntil]);

  useEffect(() => {
    const siteKey = board?.turnstileSiteKey;
    if (!siteKey || !widget.current) return;
    let id: string | undefined;
    const render = () => {
      if (!window.turnstile || !widget.current || id) return;
      id = window.turnstile.render(widget.current, {
        sitekey: siteKey,
        callback: (value: string) => setChallengeToken(value),
        "expired-callback": () => setChallengeToken(undefined),
        "error-callback": () => setChallengeToken(undefined),
      });
    };
    let script = document.querySelector<HTMLScriptElement>("script[data-turnstile]");
    if (!script) {
      script = document.createElement("script");
      script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      script.dataset.turnstile = "true";
      script.async = true;
      document.head.append(script);
    }
    script.addEventListener("load", render);
    render();
    return () => {
      script.removeEventListener("load", render);
      if (id) window.turnstile?.remove(id);
    };
  }, [board?.turnstileSiteKey]);

  useEffect(() => {
    if (job?.results.length && !cachedJobs.some((local) => local.id === job.id)) void download(job);
  }, [job, cachedJobs, download]);

  function selectDraft(next: Draft) {
    persistEditor({ draft: next, selection: null });
    setRestored(false);
    setError(null);
  }

  function showResult() {
    resultSection.current?.scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      block: "start",
    });
  }

  async function handleProcess(event: React.FormEvent) {
    event.preventDefault();
    if (disabled || submitting.current) return;
    setError(null);
    if (reusable) {
      showResult();
      return;
    }
    if (!processImages) return;
    submitting.current = true;
    setPending(true);
    const submittedKey = keyFor(draft);
    const requestId =
      !job && editor.selection?.key === submittedKey && editor.selection.requestId
        ? editor.selection.requestId
        : crypto.randomUUID();
    persistEditor({ draft, selection: { key: submittedKey, requestId } });
    setRestored(false);
    showResult();
    try {
      const result = await processImages({
        ...draft,
        prompt: draft.prompt.trim(),
        requestId,
        sessionToken: token,
        ...(challengeToken ? { challengeToken } : {}),
      });
      persistEditor({ draft, selection: { key: submittedKey, id: result.jobId, requestId } });
    } catch (cause) {
      if (!editorRef.current.selection?.id)
        setError(
          cause instanceof Error
            ? cause.message.replace(/^.*?Uncaught Error: /, "").split("\n")[0]!
            : "Your edit could not be submitted."
        );
    } finally {
      submitting.current = false;
      setPending(false);
      setChallengeToken(undefined);
      window.turnstile?.reset();
    }
  }

  return (
    <div className="app-shell">
      <main>
        <div className="intro">
          <p className="byline">A demo by Trigger.dev</p>
          <h1>Convex × Trigger.dev</h1>
          <p>Choose a photo. Describe a change. Let Trigger.dev do the background work.</p>
        </div>
        {(preview || !connected) && (
          <p className="banner" role="status">
            {preview
              ? connectionError
                ? "Connection unavailable. This is a read-only preview."
                : "Read-only preview. Connect Convex to try an edit."
              : "Connecting to Convex. Your saved images are still available below."}
          </p>
        )}

        <section className="step" aria-labelledby="choose-title">
          <div className="step-heading">
            <h2 id="choose-title">1. Choose an image</h2>
            <button
              type="button"
              className="choose-button"
              disabled={busy}
              onClick={() => setPickerOpen(true)}
            >
              Choose another image
            </button>
          </div>
          <img
            className="source-image"
            src={photograph.file}
            alt={`${photograph.name} original photograph`}
          />
        </section>

        <section className="step" aria-labelledby="edit-title">
          <h2 id="edit-title">2. Describe your edit</h2>
          <form onSubmit={handleProcess}>
            <label className="sr-only" htmlFor="prompt">
              Describe your edit
            </label>
            <textarea
              id="prompt"
              rows={3}
              maxLength={PROMPT_LIMIT}
              value={draft.prompt}
              placeholder={SUGGESTED_PROMPT}
              disabled={busy}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              onChange={(event) =>
                selectDraft({ ...draft, prompt: event.target.value, preset: DEFAULT_PRESET })
              }
            />
            {board?.turnstileSiteKey && <div className="turnstile" ref={widget} />}
            <div className="submit-row">
              <button
                className="primary-button"
                type="submit"
                disabled={disabled}
                aria-describedby={disabledReason ? "submit-reason" : undefined}
              >
                Submit
              </button>
            </div>
            {disabledReason && (
              <p id="submit-reason" className="muted" role="status">
                {disabledReason}
              </p>
            )}
          </form>
          {restored && !editing && (
            <p className="muted">{job ? "Restored your last edit." : "Restored your draft."}</p>
          )}
          {!busy && editor.selection && !job && board && (
            <p className="muted">
              Your previous submission is not available here. Submit to safely check the same
              request again.
            </p>
          )}
          {job && jobFinished(job) && (
            <button
              className="text-button"
              type="button"
              onClick={() => selectDraft({ ...draft, prompt: "" })}
            >
              New edit
            </button>
          )}
          {storageError && (
            <p className="error" role="alert">
              {storageError}
            </p>
          )}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </section>

        <div ref={resultSection} className="result-anchor">
          <JobView
            key={job?.id ?? "empty"}
            job={job}
            pending={pending}
            preview={preview}
            sessionToken={token}
            onLoad={(job) => history.download(job, true)}
          />
          {history.error && (
            <p className="error" role="alert">
              {history.error}
            </p>
          )}
        </div>

        {jobs.length > 0 && (
          <details className="history">
            <summary>Previous edits</summary>
            <ul>
              {jobs.map((previous) => (
                <li key={previous.id}>
                  <button
                    type="button"
                    className="history-item"
                    disabled={busy}
                    onClick={() => {
                      persistEditor({
                        draft: draftFor(previous),
                        selection: {
                          key: keyFor(previous),
                          id: previous.id,
                          requestId: previous.requestId,
                        },
                      });
                      setRestored(false);
                      setError(null);
                      showResult();
                    }}
                  >
                    <strong>{SAMPLES.find((sample) => sample.id === previous.sample)?.name}</strong>
                    <span>{previous.prompt}</span>
                  </button>
                </li>
              ))}
            </ul>
            {history.jobs.length > 0 && (
              <button
                className="text-button"
                type="button"
                disabled={history.clearing}
                onClick={() => void history.clear(remoteJobs.map((job) => job.id))}
              >
                {history.clearing ? "Clearing…" : "Clear local history"}
              </button>
            )}
          </details>
        )}
      </main>
      <footer>
        <span>
          Built by <a href="https://trigger.dev">Trigger.dev</a> with{" "}
          <a href="https://convex.dev">Convex</a>.{" "}
          <a
            href="https://github.com/triggerdotdev/trigger.dev/tree/main/packages/convex#readme"
            target="_blank"
            rel="noreferrer"
          >
            Integration docs ↗
          </a>
        </span>
        <span>
          Private to this browser. Photos from{" "}
          <a href={photograph.source} target="_blank" rel="noreferrer">
            Unsplash
          </a>
          .
        </span>
      </footer>
      <ImagePicker
        open={pickerOpen}
        selected={draft.sample}
        onClose={() => setPickerOpen(false)}
        onChoose={(sample) => selectDraft({ ...draft, sample, preset: DEFAULT_PRESET })}
      />
    </div>
  );
}

"use client";
import { useState } from "react";
import { ThumbsDown, ThumbsUp } from "lucide-react";
import { track } from "@/lib/analytics";

type Vote = "up" | "down";

/** "Was this page helpful?" with an optional comment, sent as an analytics event. */
export function PageFeedback({ path }: { path: string }) {
  const [vote, setVote] = useState<Vote>();
  const [comment, setComment] = useState("");
  const [sent, setSent] = useState(false);

  const send = (v: Vote, text?: string) =>
    track("docs_page_feedback", { path, helpful: v === "up", comment: text || undefined });

  if (sent)
    return (
      <p className="mt-10 border-t pt-6 text-sm text-fd-muted-foreground" role="status">
        Thanks for the feedback.
      </p>
    );

  return (
    <div className="mt-10 border-t pt-6 not-prose">
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-sm font-medium">Was this page helpful?</p>
        <div className="flex gap-1.5">
          {(["up", "down"] as const).map((v) => {
            const Icon = v === "up" ? ThumbsUp : ThumbsDown;
            return (
              <button
                key={v}
                type="button"
                aria-pressed={vote === v}
                onClick={() => {
                  setVote(v);
                  send(v);
                }}
                className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-sm text-fd-muted-foreground transition-colors hover:bg-fd-accent hover:text-fd-accent-foreground aria-pressed:border-fd-primary aria-pressed:text-fd-primary"
              >
                <Icon className="size-3.5" />
                {v === "up" ? "Yes" : "No"}
              </button>
            );
          })}
        </div>
      </div>
      {vote && (
        <form
          className="mt-3 flex max-w-xl flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (comment.trim()) send(vote, comment.trim());
            setSent(true);
          }}
        >
          <label htmlFor="feedback-comment" className="text-sm text-fd-muted-foreground">
            {vote === "up" ? "What helped? (optional)" : "What was missing or wrong? (optional)"}
          </label>
          <textarea
            id="feedback-comment"
            value={comment}
            maxLength={500}
            rows={2}
            onChange={(e) => setComment(e.target.value)}
            className="resize-y rounded-md border bg-fd-card px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-fd-ring"
          />
          <div>
            <button
              type="submit"
              className="rounded-md bg-fd-primary px-3 py-1.5 text-sm font-medium text-fd-primary-foreground hover:opacity-90"
            >
              {comment.trim() ? "Send" : "Done"}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

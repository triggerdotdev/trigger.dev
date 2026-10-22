import { useCallback, useEffect, useRef, useState } from "react";
import type { FlowAnswers } from "./flow-state";
import {
  alertDraftPatchSchema,
  applyDraftPatch,
  errorGroupToResolve,
  type ToolResultPayload,
} from "./draftPatch";
import type { SystemLine } from "~/components/alerts/CreationTranscript";
import type { ResolveErrorGroup } from "~/components/alerts/errorGroupOptions";
import { encodeErrorGroupScope } from "~/utils/errorGroupScope";

const MAX_DETAIL_LENGTH = 120;

export function sanitizeDetail(raw: string): string {
  const oneLine = raw.replace(/[\n\r]+/g, " ").trim();
  if (oneLine.length <= MAX_DETAIL_LENGTH) return oneLine;
  return oneLine.slice(0, MAX_DETAIL_LENGTH - 1) + "…";
}

type DraftResultLine = Omit<SystemLine, "id">;

export function draftResultLines(result: ToolResultPayload): DraftResultLine[] {
  if (!result.ok) {
    const raw = result.errors?.join("; ") ?? "The agent could not update the draft.";
    return [{ text: sanitizeDetail(raw), variant: "error" }];
  }
  if (!result.patch) return [];
  const parsed = alertDraftPatchSchema.safeParse(result.patch);
  if (!parsed.success) {
    return [{ text: parsed.error.issues.map((i) => i.message).join("; "), variant: "error" }];
  }
  return result.reason ? [{ text: result.reason, variant: "info" }] : [];
}

export type CreationAgentSendDeps = {
  answers: FlowAnswers;
  onPatchApplied: (next: FlowAnswers) => void;
  resetKey?: number;
  resolveErrorGroup?: ResolveErrorGroup;
};

export type CreationAgentSend = {
  handleDraftPatches: (results: ToolResultPayload[]) => void;
  handleTextReply: (text: string) => void;
  handleUserText: (text: string) => void;
  handleError: (text: string) => void;
  systemLines: SystemLine[];
};

let lineSeq = 0;
function nextLineId(): string {
  return `sysline_${++lineSeq}`;
}

export function useCreationAgentSend({
  answers,
  onPatchApplied,
  resetKey,
  resolveErrorGroup,
}: CreationAgentSendDeps): CreationAgentSend {
  const [systemLines, setSystemLines] = useState<SystemLine[]>([]);
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- This effect intentionally resets local state when the key changes.
    setSystemLines([]);
  }, [resetKey]);
  const answersRef = useRef(answers);
  const resetKeyRef = useRef(resetKey);
  const lookupSeqRef = useRef(0);
  useEffect(
    () => () => {
      lookupSeqRef.current++;
    },
    []
  );
  // oxlint-disable-next-line react/refs -- Latest-value ref kept in sync during render on purpose.
  resetKeyRef.current = resetKey;
  useEffect(() => {
    answersRef.current = answers;
  });
  const onPatchAppliedRef = useRef(onPatchApplied);
  const resolveErrorGroupRef = useRef(resolveErrorGroup);
  useEffect(() => {
    onPatchAppliedRef.current = onPatchApplied;
    resolveErrorGroupRef.current = resolveErrorGroup;
  });

  const handleDraftPatches = useCallback((results: ToolResultPayload[]) => {
    for (const result of results) {
      const parsed =
        result.ok && result.patch ? alertDraftPatchSchema.safeParse(result.patch) : undefined;
      if (parsed?.success) {
        const patched = applyDraftPatch(answersRef.current, parsed.data);
        onPatchAppliedRef.current(patched);
        answersRef.current = patched;
        const lookup = errorGroupToResolve(parsed.data);
        const resolve = resolveErrorGroupRef.current;
        if (lookup && resolve) {
          const session = resetKeyRef.current;
          const { what, scope, scopeValue } = patched;
          const seq = ++lookupSeqRef.current;
          void resolve(lookup).then((group) => {
            const current = answersRef.current;
            if (
              resetKeyRef.current !== session ||
              seq !== lookupSeqRef.current ||
              current.what !== what ||
              current.scope !== scope ||
              current.scopeValue !== scopeValue
            ) {
              return;
            }
            if (!group) {
              setSystemLines((prev) => [
                ...prev,
                { id: nextLineId(), text: `Couldn't find error ${lookup}.`, variant: "error" },
              ]);
              return;
            }
            const resolved = {
              ...answersRef.current,
              scope: "errorGroup",
              scopeValue: encodeErrorGroupScope(group),
            };
            onPatchAppliedRef.current(resolved);
            answersRef.current = resolved;
          });
        }
      }
      const lines = draftResultLines(result);
      if (lines.length > 0) {
        setSystemLines((prev) => [
          ...prev,
          ...lines.map((line) => ({ id: nextLineId(), ...line })),
        ]);
      }
    }
  }, []);

  const handleTextReply = useCallback((text: string) => {
    if (!text.trim()) return;
    setSystemLines((prev) => [...prev, { id: nextLineId(), text, variant: "reply" }]);
  }, []);

  const handleUserText = useCallback((text: string) => {
    setSystemLines((prev) => [...prev, { id: nextLineId(), text, variant: "user" }]);
  }, []);

  const handleError = useCallback((text: string) => {
    setSystemLines((prev) => [
      ...prev,
      { id: nextLineId(), text: sanitizeDetail(text), variant: "error" },
    ]);
  }, []);

  return { handleDraftPatches, handleTextReply, handleUserText, handleError, systemLines };
}

import {
  ArrowRightIcon,
  DocumentDuplicateIcon,
  ExclamationTriangleIcon,
} from "@heroicons/react/20/solid";
import { DialogClose } from "@radix-ui/react-dialog";
import { useFetcher, useLocation, useParams } from "@remix-run/react";
import { useEffect, useRef, useState } from "react";
import { InlineCode } from "~/components/code/InlineCode";
import { EnvironmentCombo, environmentFullTitle } from "~/components/environments/EnvironmentLabel";
import { Button } from "~/components/primitives/Buttons";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Dialog, DialogContent, DialogFooter, DialogHeader } from "~/components/primitives/Dialog";
import { FormError } from "~/components/primitives/FormError";
import { Hint } from "~/components/primitives/Hint";
import { Input } from "~/components/primitives/Input";
import { InputGroup } from "~/components/primitives/InputGroup";
import { useSelectedItems } from "~/components/primitives/SelectedItemsProvider";
import type { EnvironmentVariablesCompareSide } from "~/presenters/v3/EnvironmentVariablesComparePresenter.server";
import { submissionErrors } from "~/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.environment-variables/EnvironmentVariableControls";
import { hasKeyboardFocus } from "~/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.environment-variables/SelectionBar";
import { cn } from "~/utils/cn";
import { generateTwoRandomWords } from "~/utils/randomWords";
import {
  type CompareCopyPlan,
  copyEffectSentence,
  copyEmptySkippedSentence,
  copySkippedSentence,
} from "~/v3/environmentVariables/compare";

// Copying values from one side of the comparison to the other, in one confirmed step.

function valuesLabel(count: number) {
  return count === 1 ? "value" : "values";
}

/** What the dialog copies: the compare view's plan, or the needs attention page's. */
export type CopyValuesDialogPlan = {
  copied: Array<{ row: { id: string; key: string }; replaces: boolean }>;
  skipped: CompareCopyPlan["skipped"];
};

/**
 * The confirm before copying: what is new and what is replaced in the target, and which ticked
 * rows are skipped. One row is a plain confirm; several are a typed one. Always mounted, so it
 * sees its own copy finish. Values are never shown.
 */
export function CopyValuesDialog({
  plan,
  source,
  target,
  setPlan,
  restoreFocus,
}: {
  /** What to copy. Undefined while closed. */
  plan: CopyValuesDialogPlan | undefined;
  source: Pick<EnvironmentVariablesCompareSide, "environment">;
  target: Pick<EnvironmentVariablesCompareSide, "environment">;
  setPlan: (plan: undefined) => void;
  /** Where the focus goes after a copy sent from the keyboard: the control it came from is gone. */
  restoreFocus: () => void;
}) {
  const isOpen = plan !== undefined;
  const { deselectAll } = useSelectedItems();
  const [errors, setErrors] = useState<string[]>([]);
  // A fetcher, not a navigation, so a refusal comes back to the dialog.
  const fetcher = useFetcher();
  // The fetcher's data when the copy was sent, to tell a new reply from an old one. A copy that
  // goes through redirects, which leaves the data as it was.
  const submittedRef = useRef<{ data: unknown; byKeyboard: boolean } | null>(null);
  const copiedRef = useRef<{ byKeyboard: boolean } | null>(null);
  const location = useLocation();
  // The key open in the panel, if any, so the action can keep the panel open.
  const { keyParam } = useParams();
  const confirmInputRef = useRef<HTMLInputElement>(null);
  const confirmButtonRef = useRef<HTMLButtonElement>(null);
  const [confirmWord, setConfirmWord] = useState("");
  const [confirmationText, setConfirmationText] = useState("");
  const isLoading = fetcher.state !== "idle";

  const count = plan?.copied.length ?? 0;
  const isTyped = count > 1;
  const canSubmit =
    count > 0 &&
    !isLoading &&
    (!isTyped || (confirmWord !== "" && confirmationText.trim() === confirmWord));

  useEffect(() => {
    const submitted = submittedRef.current;
    if (fetcher.state !== "idle" || !submitted) {
      return;
    }
    submittedRef.current = null;
    const replyErrors = fetcher.data !== submitted.data ? submissionErrors(fetcher.data) : [];
    if (replyErrors.length > 0) {
      // oxlint-disable-next-line react/set-state-in-effect -- Shows the action's reply once it arrives.
      setErrors(replyErrors);
    } else {
      copiedRef.current = { byKeyboard: submitted.byKeyboard };
      setPlan(undefined);
      deselectAll();
    }
  }, [fetcher.state, fetcher.data, deselectAll, setPlan]);

  // A new word and an empty field each time it opens.
  useEffect(() => {
    if (isOpen) {
      // oxlint-disable-next-line react/set-state-in-effect -- Resets the confirm when it opens.
      setErrors([]);
      setConfirmWord(generateTwoRandomWords());
      setConfirmationText("");
    }
  }, [isOpen]);

  const submit = () => {
    if (!plan || !canSubmit) {
      return;
    }
    const formData = new FormData();
    formData.set("action", "copy-values");
    formData.set("sourceEnvironmentId", source.environment.id);
    formData.set("targetEnvironmentId", target.environment.id);
    if (keyParam) {
      formData.set("panelKey", keyParam);
    }
    plan.copied.forEach(({ row }, index) => formData.set(`variableIds[${index}]`, row.id));
    setErrors([]);
    submittedRef.current = {
      data: fetcher.data,
      byKeyboard: hasKeyboardFocus(document.activeElement),
    };
    // To the comparison itself, with its view, so the copy comes back to the same page.
    fetcher.submit(formData, {
      method: "post",
      action: `${location.pathname.replace(/\/key\/[^/]*$/, "")}${location.search}`,
    });
  };

  const copied = plan
    ? [...plan.copied].sort((a, b) => Number(b.replaces) - Number(a.replaces))
    : [];
  const replaceCount = copied.filter((item) => item.replaces).length;
  const newCount = count - replaceCount;
  const isMixed = replaceCount > 0 && newCount > 0;
  // Full names in sentences ("Production"); the short labels stay on the buttons that open it.
  const from = environmentFullTitle(source.environment);
  const to = environmentFullTitle(target.environment);
  const onlyKey = count === 1 ? copied[0]?.row.key : undefined;

  // One line: the dialog's divider sits under a single-line title. The key is in the sentence.
  const title = `Copy ${count} ${valuesLabel(count)} from ${from} to ${to}`;
  const effect = copyEffectSentence({ count, replaceCount, newCount, onlyKey, from, to });
  const skippedSentence = plan ? copySkippedSentence(plan.skipped, from, to) : undefined;
  const emptySkippedSentence = plan ? copyEmptySkippedSentence(plan.skipped.empty) : undefined;
  const verb = replaceCount === count ? "Replace" : newCount === count ? "Add" : "Copy";
  const busyVerb = { Replace: "Replacing", Add: "Adding", Copy: "Copying" }[verb];

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && setPlan(undefined)}>
      <DialogContent
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (isTyped ? confirmInputRef : confirmButtonRef).current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          const copied = copiedRef.current;
          if (!copied) {
            return;
          }
          copiedRef.current = null;
          // Not back to the control that opened it, which leaves with the selection.
          event.preventDefault();
          if (copied.byKeyboard) {
            restoreFocus();
          }
        }}
      >
        <DialogHeader className="pr-8">
          <span className="truncate" title={title}>
            {title}
          </span>
        </DialogHeader>
        <div className="mb-2 mt-4 flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <EnvironmentCombo environment={source.environment} />
            <ArrowRightIcon className="size-4 shrink-0 text-text-dimmed" aria-label="to" />
            <EnvironmentCombo environment={target.environment} />
          </div>
          <Paragraph
            variant="small"
            className={cn(replaceCount > 0 ? "text-text-bright" : "text-text-dimmed")}
          >
            {replaceCount > 0 && (
              <ExclamationTriangleIcon className="-mt-0.5 mr-1 inline size-4 text-warning" />
            )}
            {effect}
            {replaceCount > 0 && " This can't be undone."}
          </Paragraph>
          {!onlyKey && (
            // About eight rows, then it scrolls.
            <ul className="max-h-60 divide-y divide-grid-dimmed overflow-y-auto rounded border border-grid-bright scrollbar-thin scrollbar-track-transparent scrollbar-thumb-surface-control">
              {copied.map(({ row, replaces }) => (
                <li key={row.id} className="flex h-[30px] items-center justify-between gap-3 px-2">
                  <span className="truncate font-mono text-xs text-text-bright">{row.key}</span>
                  {/* When every row is the same, the sentence above says it once. */}
                  {isMixed && (
                    <span
                      className={cn(
                        "shrink-0 text-xs",
                        replaces ? "text-warning" : "text-text-dimmed"
                      )}
                    >
                      {replaces ? `Replaces ${to} value` : `New in ${to}`}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {skippedSentence && (
            <Paragraph variant="extra-small" className="text-text-dimmed">
              {skippedSentence}
            </Paragraph>
          )}
          {emptySkippedSentence && (
            <Paragraph variant="extra-small" className="text-text-dimmed">
              {emptySkippedSentence}
            </Paragraph>
          )}
          {isTyped && (
            <InputGroup className="max-w-full">
              <Input
                ref={confirmInputRef}
                type="text"
                placeholder="Confirmation text"
                aria-label={`Type ${confirmWord} to confirm`}
                icon={ExclamationTriangleIcon}
                fullWidth
                autoComplete="off"
                value={confirmationText}
                onChange={(e) => setConfirmationText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    submit();
                  }
                }}
              />
              <Hint>
                Type{" "}
                <InlineCode variant="extra-small" className="select-all">
                  {confirmWord}
                </InlineCode>{" "}
                to confirm.
              </Hint>
            </InputGroup>
          )}
          {errors.length > 0 && <FormError>{errors.join(" ")}</FormError>}
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="secondary/medium">Cancel</Button>
          </DialogClose>
          <Button
            ref={confirmButtonRef}
            type="button"
            variant="primary/medium"
            LeadingIcon={DocumentDuplicateIcon}
            disabled={!canSubmit}
            shortcut={{ key: "enter", enabled: false }}
            onClick={submit}
          >
            {isLoading ? `${busyVerb}…` : `${verb} ${count} ${valuesLabel(count)}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

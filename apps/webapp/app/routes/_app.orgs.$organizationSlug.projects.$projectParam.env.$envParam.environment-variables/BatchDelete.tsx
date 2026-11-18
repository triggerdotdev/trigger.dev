import { ExclamationTriangleIcon, TrashIcon } from "@heroicons/react/20/solid";
import { DialogClose } from "@radix-ui/react-dialog";
import { useFetcher, useParams } from "@remix-run/react";
import { useEffect, useRef, useState } from "react";
import {
  EnvironmentCombo,
  EnvironmentIcon,
  environmentFullTitle,
  environmentTextClassName,
} from "~/components/environments/EnvironmentLabel";
import { Button } from "~/components/primitives/Buttons";
import { Dialog, DialogContent, DialogFooter, DialogHeader } from "~/components/primitives/Dialog";
import { InlineCode } from "~/components/code/InlineCode";
import { FormError } from "~/components/primitives/FormError";
import { Hint } from "~/components/primitives/Hint";
import { Input } from "~/components/primitives/Input";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Paragraph } from "~/components/primitives/Paragraph";
import { useSelectedItems } from "~/components/primitives/SelectedItemsProvider";
import { hasKeyboardFocus } from "./SelectionBar";
import { cn } from "~/utils/cn";
import { generateTwoRandomWords } from "~/utils/randomWords";
import {
  batchDeleteItems,
  batchDeleteSummary,
  type PreviewBaseState,
} from "~/v3/environmentVariables/environmentVariableKey";
import {
  submissionErrors,
  useEnvironmentVariablesActionPath,
  type MaskedEnvironmentVariable,
} from "./EnvironmentVariableControls";

// Selecting several values in the list and deleting them in one confirmed step.

/** A listed value that can be ticked, with what the list knows of its key's Preview value. */
type SelectableEnvironmentVariable = MaskedEnvironmentVariable & {
  previewBase: PreviewBaseState;
};

/** A row's id in the selection: one value (a key in one environment), not the key. */
export function selectionId(variable: { id: string; environment: { id: string } }) {
  return `${variable.id}:${variable.environment.id}`;
}

function valuesLabel(count: number) {
  return count === 1 ? "value" : "values";
}

/**
 * The confirm for deleting the ticked values: one typed confirm for all of them, one request.
 * Opened from the selection bar's Delete. Always mounted, so it sees its own delete finish.
 */
export function BatchDeleteDialog({
  selected,
  isOpen,
  setIsOpen,
  restoreFocus,
}: {
  selected: SelectableEnvironmentVariable[];
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
  /** Where the focus goes after a delete sent from the keyboard: the bar it came from is gone. */
  restoreFocus: () => void;
}) {
  const { deselectAll } = useSelectedItems();
  const [errors, setErrors] = useState<string[]>([]);
  // A fetcher, not a navigation, so a refusal comes back to the dialog.
  const fetcher = useFetcher();
  // The fetcher's data when the delete was sent, to tell a new reply from an old one. A delete
  // that goes through redirects, which leaves the data as it was.
  const submittedRef = useRef<{ data: unknown; byKeyboard: boolean } | null>(null);
  // Set when the delete went through, with whether it was sent from the keyboard.
  const deletedRef = useRef<{ byKeyboard: boolean } | null>(null);
  const actionPath = useEnvironmentVariablesActionPath();
  // The key open in the panel, if any, so the action can keep the panel open.
  const { keyParam } = useParams();
  const confirmInputRef = useRef<HTMLInputElement>(null);
  // Typed to confirm, as when regenerating an API key. A new word each time the dialog opens.
  const [confirmWord, setConfirmWord] = useState("");
  const [confirmationText, setConfirmationText] = useState("");
  const isLoading = fetcher.state !== "idle";
  // Trimmed, so a pasted word with a space around it still matches.
  const canSubmit = confirmWord !== "" && confirmationText.trim() === confirmWord && !isLoading;

  useEffect(() => {
    const submitted = submittedRef.current;
    if (fetcher.state !== "idle" || !submitted) {
      return;
    }
    const byKeyboard = submitted.byKeyboard;
    submittedRef.current = null;
    const replyErrors = fetcher.data !== submitted.data ? submissionErrors(fetcher.data) : [];
    if (replyErrors.length > 0) {
      // oxlint-disable-next-line react/set-state-in-effect -- Shows the action's reply once it arrives.
      setErrors(replyErrors);
    } else {
      deletedRef.current = { byKeyboard };
      setIsOpen(false);
      deselectAll();
    }
  }, [fetcher.state, fetcher.data, deselectAll, setIsOpen]);

  // The ticked rows can leave the list while the dialog is open (deleted elsewhere): close it,
  // so ticking another row later doesn't bring it back with the old word and errors.
  const isEmpty = selected.length === 0;
  useEffect(() => {
    if (isEmpty) {
      // oxlint-disable-next-line react/set-state-in-effect -- Follows the selection emptying.
      setIsOpen(false);
    }
  }, [isEmpty, setIsOpen]);

  // A new word and an empty field each time it opens.
  useEffect(() => {
    if (isOpen) {
      // oxlint-disable-next-line react/set-state-in-effect -- Resets the confirm when it opens.
      setErrors([]);
      setConfirmWord(generateTwoRandomWords());
      setConfirmationText("");
    }
  }, [isOpen]);

  if (isEmpty) {
    return null;
  }

  const count = selected.length;

  const items = batchDeleteItems(selected);
  const summary = batchDeleteSummary(items);

  const submit = () => {
    const formData = new FormData();
    formData.set("action", "delete-values");
    if (keyParam) {
      formData.set("panelKey", keyParam);
    }
    selected.forEach((variable, index) => {
      formData.set(`values[${index}].id`, variable.id);
      formData.set(`values[${index}].environmentId`, variable.environment.id);
    });
    setErrors([]);
    submittedRef.current = {
      data: fetcher.data,
      byKeyboard: hasKeyboardFocus(document.activeElement),
    };
    fetcher.submit(formData, { method: "post", action: actionPath });
  };

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogContent
        className="sm:max-w-md"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          confirmInputRef.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          const deleted = deletedRef.current;
          if (!deleted) {
            return;
          }
          deletedRef.current = null;
          // Not back to the bar's Delete, which leaves with the selection.
          event.preventDefault();
          if (deleted.byKeyboard) {
            restoreFocus();
          }
        }}
      >
        <DialogHeader>
          Delete {count} environment variable {valuesLabel(count)}
        </DialogHeader>
        <div className="mb-2 mt-4 flex flex-col gap-3">
          <ul className="flex flex-col gap-1 text-sm text-text-dimmed">
            {summary.environments.map(({ type, count: inEnvironment }) => (
              <li
                key={type}
                className={cn(
                  "flex items-center gap-1.5",
                  type === "PRODUCTION" && "font-medium text-text-bright"
                )}
              >
                {type === "PRODUCTION" && (
                  <ExclamationTriangleIcon className="size-4 shrink-0 text-warning" />
                )}
                <span className="tabular-nums">{inEnvironment} in</span>
                <span className="flex items-center gap-1">
                  <EnvironmentIcon environment={{ type }} className="size-3.5 shrink-0" />
                  <span className={environmentTextClassName({ type })}>
                    {environmentFullTitle({ type })}
                  </span>
                </span>
              </li>
            ))}
            {summary.overrides.previewValue > 0 && (
              <li>
                {overridesLabel(summary.overrides.previewValue)}:{" "}
                {summary.overrides.previewValue === 1 ? "the branch" : "the branches"} will use the
                Preview value again
              </li>
            )}
            {summary.overrides.previewDeleted > 0 && (
              <li>
                {overridesLabel(summary.overrides.previewDeleted)} whose Preview value is also being
                deleted: {summary.overrides.previewDeleted === 1 ? "the branch" : "the branches"}{" "}
                will have no value
              </li>
            )}
            {summary.overrides.noValue > 0 && (
              <li>
                {overridesLabel(summary.overrides.noValue)} with no Preview value:{" "}
                {summary.overrides.noValue === 1 ? "the branch" : "the branches"} will have no value
              </li>
            )}
            {summary.overrides.unknown > 0 && <li>{overridesLabel(summary.overrides.unknown)}</li>}
          </ul>
          {/* About eight rows, then it scrolls. */}
          <ul className="max-h-60 divide-y divide-grid-dimmed overflow-y-auto rounded border border-grid-bright scrollbar-thin scrollbar-track-transparent scrollbar-thumb-surface-control">
            {items.map(({ row, dialog }) => (
              <li
                key={selectionId(row)}
                className="flex h-[30px] items-center justify-between gap-3 px-2"
              >
                <span className="truncate font-mono text-xs text-text-bright">{row.key}</span>
                <span className="flex shrink-0 items-center gap-1.5">
                  {dialog.kind === "removeOverride" && (
                    <span className="text-xs text-text-dimmed">override</span>
                  )}
                  <EnvironmentCombo environment={row.environment} className="text-xs" />
                </span>
              </li>
            ))}
          </ul>
          <Paragraph variant="small">This can't be undone.</Paragraph>
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
                  if (canSubmit) {
                    submit();
                  }
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
          {errors.length > 0 && <FormError>{errors.join(" ")}</FormError>}
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="secondary/medium">Cancel</Button>
          </DialogClose>
          <Button
            type="button"
            variant="danger/medium"
            LeadingIcon={TrashIcon}
            disabled={!canSubmit}
            shortcut={{ key: "enter", enabled: false }}
            onClick={submit}
          >
            {isLoading ? "Deleting…" : `Delete ${count} ${valuesLabel(count)}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function overridesLabel(count: number) {
  return `${count} branch ${count === 1 ? "override" : "overrides"}`;
}

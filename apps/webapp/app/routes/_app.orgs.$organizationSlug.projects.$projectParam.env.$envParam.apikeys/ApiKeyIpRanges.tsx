import { ExclamationCircleIcon, GlobeAltIcon, XMarkIcon } from "@heroicons/react/20/solid";
import { DialogClose } from "@radix-ui/react-dialog";
import { Form } from "@remix-run/react";
import { normalizeIpAddress } from "@trigger.dev/rbac/ipRanges";
import { FlaskConicalIcon } from "lucide-react";
import { useEffect, useId, useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import { Button } from "~/components/primitives/Buttons";
import { DateTime } from "~/components/primitives/DateTime";
import { Dialog, DialogContent, DialogHeader, DialogTrigger } from "~/components/primitives/Dialog";
import { FormButtons } from "~/components/primitives/FormButtons";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Label } from "~/components/primitives/Label";
import { Paragraph } from "~/components/primitives/Paragraph";
import { ShortcutKey } from "~/components/primitives/ShortcutKey";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import { TruncatedText } from "~/components/primitives/TruncatedText";
import { cn } from "~/utils/cn";
import {
  commitIpRangeEntries,
  ipRangeCoversIp,
  ipRangesDraftError,
  splitIpRangesInput,
} from "~/utils/ipRangeEntries";
import { type ActionAppearance, actionButtonProps } from "./ApiKeyActions";

export const IP_RANGES_FIELD = "allowedIpRanges";

const IP_RANGES_INPUT_ID = "api-key-ip-ranges";

const IP_RANGES_HINT = "Add IP addresses or CIDR ranges. Leave empty to allow any IP.";

const verdictTones = {
  Allowed: "bg-success/15 text-success",
  Blocked: "bg-error/15 text-error",
};

function VerdictBadge({ verdict }: { verdict: keyof typeof verdictTones }) {
  return (
    <span
      className={cn(
        "flex-none rounded-sm px-1.5 py-0.5 duration-150 animate-in fade-in zoom-in-95",
        verdictTones[verdict]
      )}
    >
      {verdict}
    </span>
  );
}

export function ApiKeyIpRangesField({
  entries,
  onChange,
  allowPrivateIpRanges,
  onDraftInvalidChange,
}: {
  entries: string[];
  onChange: (entries: string[]) => void;
  allowPrivateIpRanges: boolean;
  /** Whether the input holds text that can't be added, so the form shouldn't be submitted. */
  onDraftInvalidChange: (invalid: boolean) => void;
}) {
  const [draft, setDraft] = useState("");
  // The error shows only once the user tries to add the text, then updates as they edit it.
  const [attempted, setAttempted] = useState(false);
  const [flashed, setFlashed] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testIp, setTestIp] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const testButtonRef = useRef<HTMLButtonElement>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout>>();
  const errorId = useId();
  const keysHintId = useId();
  const hintId = useId();

  useEffect(() => () => clearTimeout(flashTimer.current), []);

  const options = { allowPrivateIpRanges };
  const draftError = draft.trim() ? ipRangesDraftError(entries, draft, options) : null;
  const error = attempted ? draftError : null;
  const draftInvalid = draftError !== null;

  useEffect(() => {
    onDraftInvalidChange(draftInvalid);
  }, [draftInvalid, onDraftInvalidChange]);

  // Add what's valid as pills. Anything that can't be added stays in the input, with its
  // message, so nothing the user typed is dropped.
  // `rest` is set when a typed separator ended the entry: it's the text after the separator.
  const commit = (text: string, rest?: string) => {
    const result = commitIpRangeEntries(entries, splitIpRangesInput(text), options);
    if (result.entries.length !== entries.length) onChange(result.entries);
    if (result.duplicate !== null) {
      // Point at the pill that's already there instead of adding it twice.
      const duplicate = result.duplicate;
      setFlashed(duplicate);
      clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => setFlashed(null), 1200);
    }
    const kept = result.rejected.map(({ value }) => value).join(" ");
    // Keep the typed separator after rejected text, so the next entry doesn't run into it.
    setDraft(rest === undefined ? kept : kept ? `${kept} ${rest}` : rest);
    setAttempted(kept.length > 0);
  };

  const remove = (index: number) => {
    onChange(entries.filter((_, i) => i !== index));
    inputRef.current?.focus();
  };

  const onInputChange = (value: string) => {
    if (/[\s,]/.test(value)) {
      // A comma or space ends an entry; whatever follows it stays in the input.
      const parts = value.split(/[\s,]+/);
      const rest = parts.pop() ?? "";
      commit(parts.join(" "), rest);
      return;
    }
    setDraft(value);
    if (!value.trim() || ipRangesDraftError(entries, value, options) === null) {
      setAttempted(false);
    }
  };

  const onPaste = (event: ClipboardEvent<HTMLInputElement>) => {
    const text = event.clipboardData.getData("text");
    // A single-line input drops newlines from pasted text, so split it here.
    if (!/[\s,]/.test(text.trim())) return;
    event.preventDefault();
    // Replace the selection (or insert at the caret), as a normal paste would.
    const input = event.currentTarget;
    const start = input.selectionStart ?? draft.length;
    const end = input.selectionEnd ?? draft.length;
    commit(draft.slice(0, start) + text + draft.slice(end));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const hasDraft = draft.trim() !== "";
    if (event.key === "Enter" && hasDraft) {
      // Enter would submit the dialog's form.
      event.preventDefault();
      commit(draft);
    } else if (event.key === "Tab" && !event.shiftKey && hasDraft && draftError === null) {
      // Stay in the field to add the next entry. Text that can't be added lets Tab move on:
      // blur keeps it in the input with its message.
      event.preventDefault();
      commit(draft);
    } else if (event.key === "Backspace" && draft === "" && entries.length > 0) {
      event.preventDefault();
      onChange(entries.slice(0, -1));
    }
  };

  const closeTester = () => {
    setTesting(false);
    setTestIp("");
    testButtonRef.current?.focus();
  };

  const onTesterKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // Enter would submit the dialog's form, and Escape would close the dialog.
    if (event.key === "Enter") event.preventDefault();
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeTester();
    }
  };

  const testValue = testing ? testIp.trim() : "";
  const testAddress = testValue ? normalizeIpAddress(testValue) : null;
  const covering = new Set(
    testAddress ? entries.filter((entry) => ipRangeCoversIp(entry, testAddress)) : []
  );
  const firstCovering = entries.find((entry) => covering.has(entry));

  return (
    <InputGroup fullWidth>
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={IP_RANGES_INPUT_ID}>Allowed IP addresses</Label>
        {/* Hidden at narrow widths, where it would crowd the label. Comma, space and leaving the
            field also add an entry; the hint names the two keys people reach for. */}
        <span
          id={keysHintId}
          className="hidden items-center whitespace-nowrap text-xs text-text-dimmed sm:flex"
        >
          <span className="sr-only">Press Enter or Tab to add</span>
          <span aria-hidden="true" className="flex items-center">
            Press
            <ShortcutKey shortcut={{ key: "enter" }} variant="small" className="mr-1" />
            or
            <ShortcutKey shortcut={{ key: "tab" }} variant="small" className="mr-1 capitalize" />
            to add
          </span>
        </span>
      </div>
      <input type="hidden" name={IP_RANGES_FIELD} value={entries.join("\n")} />
      <div
        className={cn(
          "overflow-hidden rounded border bg-input-bg shadow-xs transition has-[input:focus]:ring-1",
          error
            ? "border-error/60 has-[input:focus]:ring-error/60"
            : "border-border-bright/50 has-[input:focus]:ring-border-bright"
        )}
      >
        {/* oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- Clicking the empty space focuses the input; keyboard users tab to it. */}
        <div
          className="flex cursor-text flex-wrap items-center gap-1 p-1"
          onClick={(event) => {
            if (event.target === event.currentTarget) inputRef.current?.focus();
          }}
        >
          {entries.map((value, index) => (
            <span
              key={value}
              className={cn(
                "flex h-6 min-w-0 max-w-full items-center gap-0.5 rounded-sm border pl-1.5 font-mono text-xs transition-colors duration-150 animate-in fade-in zoom-in-95",
                covering.has(value)
                  ? "border-indigo-500/50 bg-indigo-500/15 text-indigo-400 light:text-indigo-700"
                  : flashed === value
                    ? "border-border-brighter bg-background-raised text-text-bright"
                    : "border-grid-bright bg-background-bright text-text-bright"
              )}
            >
              <span className="min-w-0 truncate">{value}</span>
              <button
                type="button"
                aria-label={`Remove ${value}`}
                onClick={() => remove(index)}
                className="flex size-5 flex-none items-center justify-center rounded-sm text-text-dimmed outline-none transition hover:bg-background-hover hover:text-text-bright focus-visible:ring-1 focus-visible:ring-border-bright"
              >
                <XMarkIcon className="size-3.5" />
              </button>
            </span>
          ))}
          <input
            ref={inputRef}
            id={IP_RANGES_INPUT_ID}
            value={draft}
            onChange={(event) => onInputChange(event.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            onBlur={() => commit(draft.trim())}
            placeholder={entries.length === 0 ? "Any IP" : undefined}
            spellCheck={false}
            autoComplete="off"
            aria-invalid={error ? true : undefined}
            aria-describedby={[keysHintId, hintId, error ? errorId : null]
              .filter(Boolean)
              .join(" ")}
            className={cn(
              "h-6 min-w-[9rem] flex-1 border-none bg-transparent px-1 py-0 font-mono text-xs outline-none placeholder:text-text-dimmed focus:ring-0",
              error ? "text-error" : "text-text-bright"
            )}
          />
        </div>
        <div className="flex h-9 items-center gap-2 border-t border-grid-dimmed bg-background-bright pl-3 pr-1 text-xs">
          <div className="flex min-w-0 flex-1 items-center">
            {testing ? (
              <div className="flex min-w-0 flex-1 items-center gap-2 duration-200 animate-in fade-in slide-in-from-right-2">
                <input
                  autoFocus
                  aria-label="IP address to test"
                  value={testIp}
                  onChange={(event) => setTestIp(event.target.value)}
                  onKeyDown={onTesterKeyDown}
                  placeholder="203.0.113.9"
                  spellCheck={false}
                  autoComplete="off"
                  className="h-6 min-w-0 flex-1 border-none bg-transparent p-0 font-mono text-xs text-text-bright outline-none placeholder:text-text-dimmed focus:ring-0"
                />
                <span
                  role="status"
                  className="flex min-w-0 max-w-[65%] items-center gap-1.5 text-text-dimmed"
                >
                  {testValue === "" ? null : testAddress === null ? (
                    <span className="truncate">Not an IP address</span>
                  ) : entries.length === 0 ? (
                    <>
                      <VerdictBadge key="any" verdict="Allowed" />
                      <span className="min-w-0 truncate">any IP can use this key</span>
                    </>
                  ) : firstCovering ? (
                    <>
                      <VerdictBadge key="Allowed" verdict="Allowed" />
                      <span className="min-w-0 truncate">
                        by <span className="font-mono text-text-bright">{firstCovering}</span>
                      </span>
                    </>
                  ) : (
                    <>
                      <VerdictBadge key="Blocked" verdict="Blocked" />
                      <span className="min-w-0 truncate">no range matches</span>
                    </>
                  )}
                </span>
              </div>
            ) : (
              <span id={hintId} className="truncate text-text-dimmed">
                {IP_RANGES_HINT}
              </span>
            )}
          </div>
          <Button
            ref={testButtonRef}
            type="button"
            variant="minimal/small"
            LeadingIcon={FlaskConicalIcon}
            leadingIconClassName="text-indigo-400 transition-transform duration-200 group-hover/button:-rotate-12 light:text-indigo-600"
            className={cn(testing && "bg-indigo-500/15")}
            tooltip={testing ? "Close the IP tester" : "Test an IP"}
            aria-label={testing ? "Close the IP tester" : "Test an IP"}
            onClick={() => (testing ? closeTester() : setTesting(true))}
          />
        </div>
      </div>
      {error ? (
        <p id={errorId} className="flex items-start gap-1.5 text-xs text-error">
          <ExclamationCircleIcon className="mt-px size-3.5 flex-none" />
          <span className="break-words">{error}</span>
        </p>
      ) : null}
    </InputGroup>
  );
}

export function ApiKeyAllowedIps({ ranges }: { ranges: string[] }) {
  // No colours of its own: the cell dims it and brightens it on row hover, like the other data.
  if (ranges.length === 0) {
    return <span className="text-xs">Any IP</span>;
  }

  // One line: a long range (IPv6) truncates, and the count of the rest stays at the end.
  const label = (
    <span className="flex max-w-[13rem] items-center gap-1 text-xs">
      {/* With more ranges, the cell's tooltip already lists them all in full. */}
      {ranges.length > 1 ? (
        <span className="min-w-0 truncate font-mono">{ranges[0]}</span>
      ) : (
        <TruncatedText text={ranges[0]} className="min-w-0 font-mono" />
      )}
      {ranges.length > 1 ? <span className="shrink-0">+{ranges.length - 1} more</span> : null}
    </span>
  );

  if (ranges.length === 1) return label;

  return (
    // asChild: the label is the trigger, so there's no button inside the row's link.
    <SimpleTooltip
      asChild
      button={label}
      disableHoverableContent
      content={
        <ul className="flex flex-col gap-0.5 font-mono text-xs">
          {ranges.map((range) => (
            <li key={range}>{range}</li>
          ))}
        </ul>
      }
    />
  );
}

export function ApiKeyLastUsed({
  lastUsedAt,
  lastUsedIp,
}: {
  lastUsedAt: Date | string | null;
  lastUsedIp: string | null;
}) {
  if (!lastUsedAt) return <>Never</>;

  // One line: the date never truncates; the IP follows it and truncates if it's a long IPv6.
  return (
    <span className="flex max-w-[16rem] items-center gap-1.5">
      <span className="shrink-0">
        <DateTime date={lastUsedAt} includeSeconds={false} />
      </span>
      {lastUsedIp ? (
        <TruncatedText text={lastUsedIp} className="min-w-0 font-mono text-xs" />
      ) : null}
    </span>
  );
}

export function EditApiKeyIpRangesButton({
  id,
  name,
  ranges,
  lastUsedIp,
  canWrite,
  allowPrivateIpRanges,
  appearance = "menu",
}: {
  id: string;
  name: string;
  ranges: string[];
  lastUsedIp: string | null;
  canWrite: boolean;
  allowPrivateIpRanges: boolean;
  appearance?: ActionAppearance;
}) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState(ranges);
  const [draftInvalid, setDraftInvalid] = useState(false);
  // Offer the shortcut only when the last used IP isn't covered and could be added.
  const canAddLastUsedIp =
    lastUsedIp !== null &&
    !entries.some((entry) => ipRangeCoversIp(entry, lastUsedIp)) &&
    ipRangesDraftError(entries, lastUsedIp, { allowPrivateIpRanges }) === null;

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (nextOpen) setEntries(ranges);
      }}
    >
      <DialogTrigger asChild>
        <Button
          {...actionButtonProps(appearance)}
          LeadingIcon={GlobeAltIcon}
          leadingIconClassName="text-text-dimmed"
          disabled={!canWrite}
          tooltip={canWrite ? undefined : "You don't have permission to edit API keys"}
        >
          Edit allowed IPs…
        </Button>
      </DialogTrigger>
      <DialogContent
        className="max-w-md"
        onOpenAutoFocus={(event) => {
          // Radix would focus the first pill's remove button, where a stray Enter deletes it.
          event.preventDefault();
          document.getElementById(IP_RANGES_INPUT_ID)?.focus();
        }}
      >
        <DialogHeader>Allowed IP addresses</DialogHeader>
        <Form method="post" className="flex flex-col gap-4 pt-3" onSubmit={() => setOpen(false)}>
          <input type="hidden" name="action" value="update-ip-ranges" />
          <input type="hidden" name="apiKeyId" value={id} />
          <Paragraph variant="small">
            Requests using "{name}" from any other IP address are rejected. Changes take effect
            immediately.
          </Paragraph>
          <ApiKeyIpRangesField
            entries={entries}
            onChange={setEntries}
            allowPrivateIpRanges={allowPrivateIpRanges}
            onDraftInvalidChange={setDraftInvalid}
          />
          {lastUsedIp ? (
            <div className="flex items-center justify-between gap-2">
              <Paragraph variant="small">
                Last used from <span className="font-mono text-text-bright">{lastUsedIp}</span>
              </Paragraph>
              {canAddLastUsedIp ? (
                <Button
                  type="button"
                  variant="secondary/small"
                  onClick={() => setEntries([...entries, lastUsedIp])}
                >
                  Add this IP
                </Button>
              ) : null}
            </div>
          ) : null}
          <FormButtons
            confirmButton={
              <Button type="submit" variant="primary/medium" disabled={draftInvalid}>
                Save
              </Button>
            }
            cancelButton={
              <DialogClose asChild>
                <Button variant="secondary/medium">Cancel</Button>
              </DialogClose>
            }
          />
        </Form>
      </DialogContent>
    </Dialog>
  );
}

import { DialogClose } from "@radix-ui/react-dialog";
import { type ApiKeyCapabilityCatalogue } from "@trigger.dev/plugins";
import { type ApiKeyAccessPreset } from "~/utils/apiKeyAccess";
import { useEffect, useState } from "react";
import { useTypedFetcher } from "remix-typedjson";
import { InlineCode } from "~/components/code/InlineCode";
import { EnvironmentCombo } from "~/components/environments/EnvironmentLabel";
import { ExpiryDatePicker, type ExpiryPreset } from "~/components/ExpiryDatePicker";
import { Button } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import { ClipboardField } from "~/components/primitives/ClipboardField";
import { Dialog, DialogContent, DialogHeader } from "~/components/primitives/Dialog";
import { FormButtons } from "~/components/primitives/FormButtons";
import { Hint } from "~/components/primitives/Hint";
import { Input } from "~/components/primitives/Input";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Label } from "~/components/primitives/Label";
import {
  apiKeyExpiryDay,
  apiKeyExpiryTimestamp,
  DEFAULT_API_KEY_EXPIRY_DAYS,
  isApiKeyExpiryDayExpired,
} from "~/utils/apiKeyExpiry";
import { cn } from "~/utils/cn";
import { ApiKeyAccessFields, ApiKeyAccessInputs, ApiKeyAccessPane } from "./ApiKeyAccessPicker";
import { ApiKeyIpRangesField } from "./ApiKeyIpRanges";
import { ApiKeyNoteInput } from "./ApiKeyNote";
import { isApiKeyNoteTooLong } from "~/utils/apiKeyNote";
import type { action, ApiKeyActionData } from "./route";
import { useApiKeyAccess } from "./useApiKeyAccess";

const API_KEY_EXPIRY_PRESETS: ExpiryPreset[] = [
  { value: "30-days", label: "In 30 days", days: 30 },
  { value: "90-days", label: "In 90 days", days: 90 },
  { value: "1-year", label: "In 1 year", days: 365 },
];

type NewApiKeyDialogProps = {
  availableTasks: string[];
  presets: ApiKeyAccessPreset[] | null;
  capabilityCatalogue: ApiKeyCapabilityCatalogue | null;
  isRbacPluginAvailable: boolean;
  canManagePresets: boolean;
  allowPrivateIpRanges: boolean;
  environment: React.ComponentProps<typeof EnvironmentCombo>["environment"];
  children?: (openDialog: () => void) => React.ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function NewApiKeyDialog({
  children,
  open,
  onOpenChange,
  availableTasks,
  presets,
  capabilityCatalogue,
  isRbacPluginAvailable,
  canManagePresets,
  allowPrivateIpRanges,
  environment,
}: NewApiKeyDialogProps) {
  const fetcher = useTypedFetcher<typeof action>();
  const actionData = fetcher.data as ApiKeyActionData | undefined;
  const [showError, setShowError] = useState(false);
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [expiration, setExpiration] = useState("90-days");
  const [expiryDate, setExpiryDate] = useState<Date | undefined>(() =>
    apiKeyExpiryDay(new Date(), DEFAULT_API_KEY_EXPIRY_DAYS)
  );
  const [expiryError, setExpiryError] = useState(false);
  const expiresAt = expiryDate ? apiKeyExpiryTimestamp(expiryDate) : undefined;
  const access = useApiKeyAccess({
    presets,
    catalogue: capabilityCatalogue,
    isRbacPluginAvailable,
    canManagePresets,
  });
  const [ipRanges, setIpRanges] = useState<string[]>([]);
  const [ipRangesDraftInvalid, setIpRangesDraftInvalid] = useState(false);
  const [createdApiKey, setCreatedApiKey] = useState<string>();

  useEffect(() => {
    if (fetcher.state !== "idle") {
      return;
    }

    if (actionData?.ok && actionData.action === "create") {
      // oxlint-disable-next-line react/set-state-in-effect -- This effect intentionally synchronizes route state after an external or lifecycle change.
      setCreatedApiKey(actionData.apiKey);
    } else if (actionData && !actionData.ok) {
      setShowError(true);
    }
  }, [actionData, fetcher.state]);

  function handleOpenChange(nextOpen: boolean) {
    onOpenChange(nextOpen);
    if (nextOpen) {
      setName("");
      setNote("");
      setExpiration("90-days");
      setExpiryDate(apiKeyExpiryDay(new Date(), DEFAULT_API_KEY_EXPIRY_DAYS));
      setExpiryError(false);
      access.reset();
      setIpRanges([]);
      setCreatedApiKey(undefined);
      setShowError(false);
    }
  }

  const {
    showAccessControls,
    selectedTasks,
    needsSelectedTask,
    deletedPresetNote,
    canSubmitAccess,
  } = access;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {children?.(() => handleOpenChange(true))}
      <DialogContent
        className={cn(
          "max-h-[80vh] grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden p-0 pt-2.5",
          showAccessControls ? "lg:max-w-[62rem]" : "lg:max-w-[40rem]"
        )}
      >
        <DialogHeader className="flex flex-row items-center gap-1.5 px-5 pb-3">
          New API key
          <EnvironmentCombo
            environment={environment}
            className="text-base"
            iconClassName="size-5"
          />
        </DialogHeader>
        {createdApiKey ? (
          <div className="flex flex-col gap-3 p-4">
            <Callout variant="success">
              Copy this API key and store it in a secure place. You won't be able to see it again.
            </Callout>
            <ClipboardField
              secure
              value={createdApiKey}
              variant="secondary/medium"
              className="w-full"
            />
            <Callout variant="warning">
              Use <InlineCode variant="extra-small">@trigger.dev/sdk</InlineCode> v4.5.8 or later.
              Older SDK versions mint an unusable token when{" "}
              <InlineCode variant="extra-small">auth.createPublicToken()</InlineCode> is called with
              this API key.
            </Callout>
            <FormButtons
              confirmButton={
                <DialogClose asChild>
                  <Button variant="primary/medium">Done</Button>
                </DialogClose>
              }
            />
          </div>
        ) : (
          <fetcher.Form
            method="post"
            onSubmit={(event) => {
              setShowError(false);
              const expired = expiryDate !== undefined && isApiKeyExpiryDayExpired(expiryDate);
              setExpiryError(expired);
              if (expired) event.preventDefault();
            }}
            className="grid min-h-0 grid-rows-[minmax(0,1fr)_auto]"
          >
            <input type="hidden" name="action" value="create" />
            {expiresAt ? (
              <input type="hidden" name="expiresAt" value={expiresAt.toISOString()} />
            ) : null}
            <ApiKeyAccessInputs access={access} />
            <div
              className={cn(
                "grid min-h-0 grid-cols-1 overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-surface-control",
                // The scrollbar runs beside the summary pane, so its track takes the pane's colour.
                showAccessControls &&
                  "lg:grid-cols-[minmax(0,1fr)_21rem] lg:scrollbar-track-background-deep"
              )}
            >
              <div className={cn("min-w-0 px-5 pb-4 pt-4", showAccessControls && "space-y-5")}>
                <div
                  className={cn(
                    "grid items-start gap-4 sm:grid-cols-[minmax(0,1fr)_16rem]",
                    showAccessControls && "border-b border-grid-dimmed pb-5"
                  )}
                >
                  <InputGroup fullWidth>
                    <Label htmlFor="api-key-name">Name</Label>
                    <Input
                      id="api-key-name"
                      name="name"
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      placeholder="e.g. Stripe webhooks"
                      maxLength={64}
                      autoComplete="off"
                      fullWidth
                    />
                    <Hint>Use a name that identifies where this key will be used.</Hint>
                  </InputGroup>

                  <InputGroup fullWidth>
                    <Label htmlFor="api-key-expiry">Expires</Label>
                    <ExpiryDatePicker
                      id="api-key-expiry"
                      presets={API_KEY_EXPIRY_PRESETS}
                      allowNever
                      expiration={expiration}
                      date={expiryDate}
                      onChange={(nextExpiration, date) => {
                        setExpiration(nextExpiration);
                        setExpiryDate(date);
                        setExpiryError(false);
                      }}
                    />
                    <Hint>
                      {expiration === "never"
                        ? "Works until you revoke it."
                        : "Expires at the end of the chosen day, UTC."}
                    </Hint>
                  </InputGroup>

                  <div className="sm:col-span-2">
                    <ApiKeyNoteInput value={note} onChange={setNote} />
                  </div>

                  <div className="sm:col-span-2">
                    <ApiKeyIpRangesField
                      entries={ipRanges}
                      onChange={setIpRanges}
                      allowPrivateIpRanges={allowPrivateIpRanges}
                      onDraftInvalidChange={setIpRangesDraftInvalid}
                    />
                  </div>
                </div>

                <ApiKeyAccessFields access={access} availableTasks={availableTasks} />
              </div>

              <ApiKeyAccessPane access={access} />
            </div>

            <div className="flex items-center justify-between gap-3 border-t border-grid-bright p-3">
              <DialogClose asChild>
                <Button variant="secondary/medium">Cancel</Button>
              </DialogClose>
              <div className="flex min-w-0 items-center gap-3">
                {(() => {
                  const error = expiryError
                    ? "This expiry date has passed. Choose another date."
                    : showError && actionData && !actionData.ok
                      ? actionData.error
                      : null;
                  const hint =
                    needsSelectedTask && selectedTasks.length === 0
                      ? "Pick at least one task, or switch to all tasks."
                      : "";
                  const warning = error ?? deletedPresetNote;
                  return (
                    <span
                      className={cn(
                        "min-w-0 truncate text-xs",
                        warning ? "text-error" : "text-text-dimmed"
                      )}
                    >
                      {warning ?? hint}
                    </span>
                  );
                })()}
                <Button
                  type="submit"
                  variant="primary/medium"
                  className="shrink-0"
                  disabled={
                    !name.trim() ||
                    isApiKeyNoteTooLong(note) ||
                    ipRangesDraftInvalid ||
                    !canSubmitAccess ||
                    fetcher.state !== "idle"
                  }
                  isLoading={fetcher.state !== "idle"}
                >
                  Create API key
                </Button>
              </div>
            </div>
          </fetcher.Form>
        )}
      </DialogContent>
    </Dialog>
  );
}

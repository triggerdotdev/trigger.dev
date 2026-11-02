import { DialogClose } from "@radix-ui/react-dialog";
import { useEffect, useState } from "react";
import { useTypedFetcher } from "remix-typedjson";
import { EnvironmentCombo } from "~/components/environments/EnvironmentLabel";
import { InlineCode } from "~/components/code/InlineCode";
import { Feedback } from "~/components/Feedback";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import { ClipboardField } from "~/components/primitives/ClipboardField";
import { Dialog, DialogContent, DialogHeader } from "~/components/primitives/Dialog";
import { FormButtons } from "~/components/primitives/FormButtons";
import { Hint } from "~/components/primitives/Hint";
import { Input } from "~/components/primitives/Input";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Label } from "~/components/primitives/Label";
import { Paragraph } from "~/components/primitives/Paragraph";
import { RadioGroup, RadioGroupItem } from "~/components/primitives/RadioButton";
import { Select, SelectItem } from "~/components/primitives/Select";
import SegmentedControl from "~/components/primitives/SegmentedControl";
import { MAX_API_KEY_TASK_IDENTIFIERS } from "~/consts";
import { useFeatures } from "~/hooks/useFeatures";
import { useOrganization } from "~/hooks/useOrganizations";
import { useShowSelfServe } from "~/hooks/useShowSelfServe";
import type { ApiKeyPreset } from "~/services/apiKeyPresetValidation.server";
import { SCOPE_CAPABILITIES, scopeDetailForPreset } from "~/utils/apiKeyScopeDetail";
import { cn } from "~/utils/cn";
import { v3BillingPath } from "~/utils/pathBuilder";
import type { action, ApiKeyActionData } from "./route";

type NewApiKeyDialogProps = {
  availableTasks: string[];
  presets: ApiKeyPreset[] | null;
  isRbacPluginAvailable: boolean;
  environment: React.ComponentProps<typeof EnvironmentCombo>["environment"];
  children: (openDialog: () => void) => React.ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function NewApiKeyDialog({
  children,
  open,
  onOpenChange,
  availableTasks,
  presets,
  isRbacPluginAvailable,
  environment,
}: NewApiKeyDialogProps) {
  const fetcher = useTypedFetcher<typeof action>();
  const actionData = fetcher.data as ApiKeyActionData | undefined;
  const [showError, setShowError] = useState(false);
  const [name, setName] = useState("");
  const [expiration, setExpiration] = useState("90-days");
  const defaultPresetId =
    presets?.find((preset) => preset.id === "FULL_ACCESS" && preset.available)?.id ??
    presets?.find((preset) => preset.available)?.id ??
    "FULL_ACCESS";
  const additionalPresetIds =
    presets?.filter((preset) => !KNOWN_PRESET_IDS.has(preset.id)).map((preset) => preset.id) ?? [];
  const expiresAt = expirationDate(expiration);
  const [presetId, setPresetId] = useState(defaultPresetId);
  const [taskScope, setTaskScope] = useState<"all" | "selected">("all");
  const [selectedTasks, setSelectedTasks] = useState<string[]>([]);
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
      setExpiration("90-days");
      setPresetId(defaultPresetId);
      setTaskScope("all");
      setSelectedTasks([]);
      setCreatedApiKey(undefined);
      setShowError(false);
    }
  }

  const selectedPreset = presets?.find((preset) => preset.id === presetId);
  const showAccessControls = isRbacPluginAvailable && presets !== null;
  const selectedPresetIsAvailable = !showAccessControls || selectedPreset?.available === true;
  const scopeDetail = scopeDetailForPreset(selectedPreset);
  const usesTaskSelection = showAccessControls && (selectedPreset?.usesTaskSelection ?? false);
  const showTaskAccess = selectedPresetIsAvailable && usesTaskSelection;
  const needsSelectedTask = usesTaskSelection && taskScope === "selected";

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {children(() => handleOpenChange(true))}
      <DialogContent
        className={cn(
          "max-h-[80vh] grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden p-0 pt-2.5",
          showAccessControls ? "lg:max-w-[62rem]" : "lg:max-w-[40rem]"
        )}
      >
        <DialogHeader className="flex flex-row items-center gap-2.5 px-5 pb-3">
          New API key
          <EnvironmentCombo environment={environment} className="text-xs" iconClassName="size-4" />
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
                  <Button variant="primary/small">Done</Button>
                </DialogClose>
              }
            />
          </div>
        ) : (
          <fetcher.Form
            method="post"
            onSubmit={() => setShowError(false)}
            className="grid min-h-0 grid-rows-[minmax(0,1fr)_auto]"
          >
            <input type="hidden" name="action" value="create" />
            {expiresAt ? (
              <input type="hidden" name="expiresAt" value={expiresAt.toISOString()} />
            ) : null}
            {presetId ? <input type="hidden" name="presetId" value={presetId} /> : null}
            {usesTaskSelection ? <input type="hidden" name="taskScope" value={taskScope} /> : null}
            {usesTaskSelection && taskScope === "selected"
              ? selectedTasks.map((taskIdentifier) => (
                  <input
                    key={taskIdentifier}
                    type="hidden"
                    name="taskIdentifiers"
                    value={taskIdentifier}
                  />
                ))
              : null}
            <div
              className={cn(
                "grid min-h-0 grid-cols-1 overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-surface-control",
                showAccessControls && "lg:grid-cols-[minmax(0,1fr)_21rem]"
              )}
            >
              <div className={cn("min-w-0 px-5 pb-6 pt-4", showAccessControls && "space-y-5")}>
                <div
                  className={cn(
                    "grid gap-4 pb-5 sm:grid-cols-[minmax(0,1fr)_12rem]",
                    showAccessControls && "border-b border-grid-dimmed"
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
                    <Label>Expires</Label>
                    <Select<string, { value: string; label: string }>
                      value={expiration}
                      setValue={setExpiration}
                      items={API_KEY_EXPIRATIONS}
                      variant="secondary/medium"
                      dropdownIcon
                      className="w-full justify-between"
                      text={(value) =>
                        API_KEY_EXPIRATIONS.find((option) => option.value === value)?.label
                      }
                    >
                      {(options) =>
                        options.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))
                      }
                    </Select>
                    <Hint>{formatExpiryHint(expiresAt)}</Hint>
                  </InputGroup>
                </div>

                {showAccessControls && presets ? (
                  <RadioGroup value={presetId} onValueChange={setPresetId} className="space-y-4">
                    <PresetOptions presets={presets} ids={["FULL_ACCESS"]} className="grid" />
                    <PresetGroup
                      title="Trigger and operate tasks"
                      presets={presets}
                      ids={["TRIGGER_ONLY", "TASK_OPERATOR"]}
                    />
                    <div
                      className={cn(
                        "grid transition-[grid-template-rows,opacity] duration-200 ease-out",
                        showTaskAccess
                          ? "grid-rows-[1fr] opacity-100"
                          : "pointer-events-none grid-rows-[0fr] opacity-0"
                      )}
                    >
                      <div className="min-h-0 overflow-hidden">
                        <TaskAccessPanel
                          scopable={usesTaskSelection}
                          taskLabel={scopeDetail?.taskLabel ?? "Scope details unavailable"}
                          taskScope={taskScope}
                          setTaskScope={setTaskScope}
                          selectedTasks={selectedTasks}
                          setSelectedTasks={setSelectedTasks}
                          availableTasks={availableTasks}
                        />
                      </div>
                    </div>
                    <PresetGroup
                      title="Environment capabilities"
                      presets={presets}
                      ids={[
                        "ENVIRONMENT_OBSERVER",
                        "ENVIRONMENT_OPERATOR",
                        "WEBHOOKS_ONLY",
                        "WAITPOINTS_ONLY",
                      ]}
                    />
                    <PresetGroup
                      title="Deployment and configuration"
                      presets={presets}
                      ids={["DEPLOY_ONLY", "ENV_VARS_ONLY"]}
                    />
                    {additionalPresetIds.length > 0 ? (
                      <PresetGroup
                        title="Other access"
                        presets={presets}
                        ids={additionalPresetIds}
                      />
                    ) : null}
                  </RadioGroup>
                ) : null}
              </div>

              {showAccessControls ? (
                <ApiKeyScopePanel
                  preset={selectedPreset}
                  taskScope={usesTaskSelection ? taskScope : undefined}
                  selectedTasks={selectedTasks}
                  showUpgradeCta={selectedPreset ? !selectedPreset.available : false}
                />
              ) : null}
            </div>

            <div className="flex items-center gap-3 border-t border-grid-bright px-5 py-3">
              {(() => {
                const error = showError && actionData && !actionData.ok ? actionData.error : null;
                const hint =
                  needsSelectedTask && selectedTasks.length === 0
                    ? "Pick at least one task, or switch to all tasks."
                    : "";
                return (
                  <span
                    className={cn(
                      "min-w-0 truncate text-xs",
                      error ? "text-error" : "text-text-dimmed"
                    )}
                  >
                    {error ?? hint}
                  </span>
                );
              })()}
              <div className="ml-auto flex shrink-0 items-center gap-2">
                <DialogClose asChild>
                  <Button variant="tertiary/small">Cancel</Button>
                </DialogClose>
                <Button
                  type="submit"
                  variant="primary/small"
                  disabled={
                    !name.trim() ||
                    !selectedPresetIsAvailable ||
                    (needsSelectedTask &&
                      (selectedTasks.length === 0 ||
                        selectedTasks.length > MAX_API_KEY_TASK_IDENTIFIERS)) ||
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

const KNOWN_PRESET_IDS = new Set([
  "FULL_ACCESS",
  "TRIGGER_ONLY",
  "TASK_OPERATOR",
  "ENVIRONMENT_OBSERVER",
  "ENVIRONMENT_OPERATOR",
  "DEPLOY_ONLY",
  "ENV_VARS_ONLY",
  "WEBHOOKS_ONLY",
  "WAITPOINTS_ONLY",
]);

const API_KEY_EXPIRATIONS = [
  { value: "30-days", label: "In 30 days" },
  { value: "90-days", label: "In 90 days" },
  { value: "1-year", label: "In 1 year" },
  { value: "never", label: "Never" },
];

// 0 none · 1 read · 2 read & write · 3 allowed (an action) · 4 full
const SCOPE_LEVEL_WORDS = ["No access", "Read", "Read & write", "Allowed", "Full access"] as const;
const SCOPE_LEVEL_TONES = ["none", "read", "write", "write", "write"] as const;

type ScopeTone = (typeof SCOPE_LEVEL_TONES)[number];

function expandScopeString(raw: string, scoped: boolean, tasks: string[]): string[] {
  const parts = raw.split(":");
  if (!scoped || parts.length !== 2 || parts[1] !== "tasks") {
    return [raw];
  }

  const shown = tasks.slice(0, 3).map((task) => `${raw}:${task}`);
  if (tasks.length > 3) {
    shown.push(`… +${tasks.length - 3} more`);
  }
  return shown;
}

function formatExpiryHint(expiresAt?: Date): string {
  if (!expiresAt) {
    return "Works until you revoke it";
  }
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(expiresAt);
}

function expirationDate(expiration: string): Date | undefined {
  const days = { "30-days": 30, "90-days": 90, "1-year": 365 }[expiration];
  return days ? new Date(Date.now() + days * 24 * 60 * 60 * 1_000) : undefined;
}

function PresetGroup({
  title,
  presets,
  ids,
}: {
  title: string;
  presets: ApiKeyPreset[];
  ids: string[];
}) {
  return (
    <div className="space-y-2.5">
      <div className="text-xxs font-semibold uppercase tracking-wider text-indigo-400">{title}</div>
      <PresetOptions presets={presets} ids={ids} className="grid gap-2.5 sm:grid-cols-2" />
    </div>
  );
}

function PresetOptions({
  presets,
  ids,
  className,
}: {
  presets: ApiKeyPreset[];
  ids: string[];
  className?: string;
}) {
  return (
    <div className={className}>
      {ids
        .flatMap((id) => presets.filter((preset) => preset.id === id))
        .map((preset) => (
          <RadioGroupItem
            key={preset.id}
            id={`api-key-access-${preset.id}`}
            value={preset.id}
            variant="description"
            className="h-full min-h-[3.5rem] items-start border-grid-bright bg-background-bright p-3 shadow-none [&_p]:mt-0.5 [&_p]:text-xs [&_p]:leading-snug hover:border-border-bright hover:bg-background-hover data-[state=checked]:border-indigo-500/70 data-[state=checked]:bg-indigo-500/10 hover:data-[state=checked]:bg-indigo-500/15"
            label={
              preset.id === "FULL_ACCESS" ? (
                <span className="flex items-center gap-2">
                  {preset.label}
                  <span className="rounded-[3px] bg-amber-500/15 px-1.5 py-0.5 text-xxs font-semibold uppercase tracking-wide text-amber-400">
                    Full access
                  </span>
                </span>
              ) : (
                preset.label
              )
            }
            description={preset.description}
            badges={preset.available ? undefined : ["Upgrade"]}
          />
        ))}
    </div>
  );
}

function ApiKeyScopePanel({
  preset,
  taskScope,
  selectedTasks,
  showUpgradeCta,
}: {
  preset?: ApiKeyPreset;
  taskScope?: "all" | "selected";
  selectedTasks: string[];
  showUpgradeCta: boolean;
}) {
  const detail = scopeDetailForPreset(preset);
  const scoped = Boolean(detail?.scopable && taskScope === "selected" && selectedTasks.length > 0);

  if (showUpgradeCta) {
    return (
      <aside className="border-t border-grid-bright bg-background-deep lg:border-l lg:border-t-0">
        <div className="px-5 pb-6 pt-4">
          <ApiKeyScopeUpgradeCta show />
        </div>
      </aside>
    );
  }

  if (!detail) {
    return (
      <aside className="border-t border-grid-bright bg-background-deep lg:border-l lg:border-t-0">
        <div className="px-5 pb-6 pt-4">
          <p className="text-xs text-text-dimmed">
            Scope details are unavailable for this access preset.
          </p>
        </div>
      </aside>
    );
  }

  return (
    <aside className="border-t border-grid-bright bg-background-deep lg:border-l lg:border-t-0">
      <div className="px-5 pb-6 pt-4">
        <div className="space-y-4">
          <ul className="flex flex-col">
            {SCOPE_CAPABILITIES.map(([key, label]) => {
              const cap = detail.admin ? undefined : detail.caps[key];
              const level = detail.admin ? 4 : cap ? cap[0] : 0;
              const rawScopes = cap?.[1];
              const tone: ScopeTone = SCOPE_LEVEL_TONES[level] ?? "none";
              const rows = rawScopes?.flatMap((raw) =>
                expandScopeString(raw, scoped, selectedTasks)
              );

              return (
                <li key={key} className="border-t border-grid-dimmed py-2.5 first:border-t-0">
                  <div className="flex items-baseline gap-2.5">
                    <span
                      className={cn(
                        "mt-1.5 size-1.5 shrink-0 rounded-[2px]",
                        tone === "read"
                          ? "bg-blue-500"
                          : tone === "write"
                            ? "bg-amber-500"
                            : // A dot has to stay visible, so this tracks the
                              // dimmed text color rather than a surface color
                              // that would all but vanish on a light card.
                              "bg-text-dimmed"
                      )}
                    />
                    <span
                      className={cn(
                        "min-w-0 flex-1 text-sm",
                        level === 0 ? "text-text-dimmed" : "text-text-bright"
                      )}
                    >
                      {label}
                    </span>
                    <span className="whitespace-nowrap text-xs text-text-dimmed">
                      {SCOPE_LEVEL_WORDS[level] ?? "No access"}
                    </span>
                  </div>
                  {rows && rows.length > 0 ? (
                    <div className="ml-4 mt-1 flex flex-col gap-0.5">
                      {rows.map((row) => (
                        <code
                          key={row}
                          className={cn(
                            "break-all font-mono text-xxs leading-relaxed",
                            row.startsWith("…")
                              ? "text-text-dimmed"
                              : tone === "read"
                                ? "text-blue-400/80"
                                : "text-amber-400/80"
                          )}
                        >
                          {row}
                        </code>
                      ))}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </aside>
  );
}

function ApiKeyScopeUpgradeCta({ show }: { show: boolean }) {
  const { isManagedCloud } = useFeatures();
  const organization = useOrganization();
  const showSelfServe = useShowSelfServe();

  if (!show) return null;

  if (!isManagedCloud) {
    return (
      <div className="text-right">
        <Paragraph variant="small">
          Restricted API keys aren't available on your current plan. Contact your administrator to
          enable them.
        </Paragraph>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-end text-right">
      <Paragraph variant="small" className="mb-3">
        Upgrade to create restricted keys.
      </Paragraph>
      {showSelfServe ? (
        <LinkButton variant="primary/small" to={v3BillingPath(organization)}>
          View plans
        </LinkButton>
      ) : (
        <Feedback
          defaultValue="enterprise"
          button={<Button variant="secondary/small">Contact us</Button>}
        />
      )}
    </div>
  );
}

function TaskAccessPanel({
  scopable,
  taskLabel,
  taskScope,
  setTaskScope,
  selectedTasks,
  setSelectedTasks,
  availableTasks,
}: {
  scopable: boolean;
  taskLabel: string;
  taskScope: "all" | "selected";
  setTaskScope: (value: "all" | "selected") => void;
  selectedTasks: string[];
  setSelectedTasks: (value: string[]) => void;
  availableTasks: string[];
}) {
  return (
    <div className="rounded-md border border-grid-bright bg-background-bright/40 p-3.5">
      <div className="text-2sm font-medium text-text-bright">Task access</div>
      {/* Reserve room for the segmented control plus the Selected-tasks
          dropdown, so the panel keeps a constant height across presets and the
          dropdown never pushes the dialog past its bounds. */}
      <div className="mt-3 min-h-[5.5rem]">
        {!scopable ? (
          <p className="flex h-10 items-center text-2sm text-text-dimmed">{taskLabel}</p>
        ) : (
          <>
            <SegmentedControl
              name="task-scope"
              value={taskScope}
              onChange={(value) => setTaskScope(value as "all" | "selected")}
              fullWidth
              options={[
                { label: "All tasks", value: "all" },
                { label: "Selected tasks", value: "selected" },
              ]}
            />
            {taskScope === "selected" ? (
              <Select<string[], string>
                value={selectedTasks}
                setValue={setSelectedTasks}
                placeholder="Choose tasks"
                text={(tasks) =>
                  tasks.length === 0
                    ? undefined
                    : `${tasks.length} selected ${tasks.length === 1 ? "task" : "tasks"}`
                }
                variant="secondary/medium"
                dropdownIcon
                items={availableTasks}
                filter
                heading="Search tasks"
                empty={<div className="p-3 text-xs text-text-dimmed">No tasks found.</div>}
                className="mt-2 w-full justify-between"
                popoverClassName="max-h-64"
              >
                {(tasks) =>
                  tasks.map((taskIdentifier) => (
                    <SelectItem key={taskIdentifier} value={taskIdentifier} checkPosition="left">
                      <span className="font-mono text-text-bright">{taskIdentifier}</span>
                    </SelectItem>
                  ))
                }
              </Select>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

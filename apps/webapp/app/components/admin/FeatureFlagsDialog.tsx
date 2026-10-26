import { useFetcher } from "@remix-run/react";
import { useEffect, useRef, useState } from "react";
import stableStringify from "json-stable-stringify";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogDescription,
  DialogFooter,
} from "~/components/primitives/Dialog";
import { Button } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import { LockClosedIcon } from "@heroicons/react/20/solid";
import { CheckboxWithLabel } from "~/components/primitives/Checkbox";
import { cn } from "~/utils/cn";
import {
  FEATURE_FLAG,
  derivedFlagsClearedWith,
  ORG_LOCKED_FLAG_EFFECT,
  ORG_LOCKED_FLAGS,
  isUnchangedInvalidFlag,
  type FeatureFlagKey,
  type FlagControlType,
  type OrgLockedFlagEffect,
} from "~/v3/featureFlags";
import {
  UNSET_VALUE,
  BooleanControl,
  EnumControl,
  NumberControl,
  StringControl,
  WorkerGroupControl,
  WorkerQueueEnvironmentOverridesControl,
  type WorkerGroup,
} from "./FlagControls";
import {
  incompleteOverrideScopes,
  type OverrideEnvironment,
  type WorkerQueueEnvironmentOverrides,
} from "./workerQueueEnvironmentOverrides";

type LoaderData = {
  org: { id: string; title: string; slug: string };
  orgFlags: Record<string, unknown>;
  invalidOrgFlags?: Record<string, unknown>;
  globalFlags: Record<string, unknown>;
  controlTypes: Record<string, FlagControlType>;
  workerGroupName?: string;
  workerGroups?: WorkerGroup[];
  environments?: OverrideEnvironment[];
  isManagedCloud?: boolean;
};

const LOCKED_EFFECT_LABEL: Record<OrgLockedFlagEffect, string> = {
  live: "overrides global",
  ignored: "stored, ignored",
  derived: "grace stamp",
};

// Most flags fall back to global when the org value fails its schema, but not all of them.
const INVALID_VALUE_LABEL: Partial<Record<string, string>> = {
  [FEATURE_FLAG.dashboardAgentTurnEvalsEnabled]: "invalid, treated as off",
  [FEATURE_FLAG.workerQueueEnvironmentOverrides]: "invalid, valid entries still apply",
};

function formatStoredValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

type ActionData = {
  success?: boolean;
  error?: string;
};

type FeatureFlagsDialogProps = {
  orgId: string | null;
  orgTitle: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function FeatureFlagsDialog({
  orgId,
  orgTitle,
  open,
  onOpenChange,
}: FeatureFlagsDialogProps) {
  const loadFetcher = useFetcher<LoaderData>();
  const saveFetcher = useFetcher<ActionData>();
  const loadFeatureFlags = loadFetcher.load;
  const onOpenChangeRef = useRef(onOpenChange);
  // oxlint-disable-next-line react/refs -- This ref intentionally coordinates an imperative integration outside React state.
  onOpenChangeRef.current = onOpenChange;

  const [overrides, setOverrides] = useState<Record<string, unknown>>({});
  const [initialOverrides, setInitialOverrides] = useState<Record<string, unknown>>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [unlocked, setUnlocked] = useState(false);

  const isLocked = (key: string) =>
    (!unlocked || ORG_LOCKED_FLAG_EFFECT[key as FeatureFlagKey] === "derived") &&
    ORG_LOCKED_FLAGS.includes(key);

  useEffect(() => {
    if (open && orgId) {
      // oxlint-disable-next-line react/set-state-in-effect -- This effect intentionally synchronizes local state after an external or lifecycle change.
      setSaveError(null);
      setOverrides({});
      setInitialOverrides({});
      loadFeatureFlags(`/admin/api/v2/orgs/${orgId}/feature-flags`);
    }
  }, [loadFeatureFlags, open, orgId]);

  useEffect(() => {
    if (loadFetcher.data) {
      // Invalid stored values ride along unchanged, so a save keeps them unless unset.
      const loaded = { ...loadFetcher.data.orgFlags, ...loadFetcher.data.invalidOrgFlags };
      // oxlint-disable-next-line react/set-state-in-effect -- This effect intentionally synchronizes local state after an external or lifecycle change.
      setOverrides({ ...loaded });
      setInitialOverrides({ ...loaded });
    }
  }, [loadFetcher.data]);

  useEffect(() => {
    if (saveFetcher.data?.success) {
      onOpenChangeRef.current(false);
    } else if (saveFetcher.data?.error) {
      // oxlint-disable-next-line react/set-state-in-effect -- This effect intentionally synchronizes local state after an external or lifecycle change.
      setSaveError(saveFetcher.data.error);
    }
  }, [saveFetcher.data]);

  const isDirty = stableStringify(overrides) !== stableStringify(initialOverrides);
  // An untouched invalid stored value isn't a draft: it renders as an invalid row, not the editor.
  const environmentOverrides = (
    isUnchangedInvalidFlag(
      FEATURE_FLAG.workerQueueEnvironmentOverrides,
      overrides,
      loadFetcher.data?.invalidOrgFlags
    )
      ? {}
      : (overrides[FEATURE_FLAG.workerQueueEnvironmentOverrides] ?? {})
  ) as WorkerQueueEnvironmentOverrides;
  const hasIncompleteOverrides = incompleteOverrideScopes(environmentOverrides).length > 0;

  const setFlagValue = (key: string, value: unknown) => {
    setOverrides((prev) => ({ ...prev, [key]: value }));
  };

  const unsetFlag = (key: string) => {
    setOverrides((prev) => {
      const next = { ...prev };
      delete next[key];
      for (const derivedKey of derivedFlagsClearedWith(key)) {
        delete next[derivedKey];
      }
      return next;
    });
  };

  const handleSave = () => {
    if (!orgId) return;
    const body = Object.keys(overrides).length === 0 ? null : overrides;
    saveFetcher.submit(JSON.stringify(body), {
      method: "POST",
      action: `/admin/api/v2/orgs/${orgId}/feature-flags`,
      encType: "application/json",
    });
  };

  const data = loadFetcher.data;
  const isLoading = loadFetcher.state === "loading";
  const isSaving = saveFetcher.state === "submitting";

  const jsonPreview =
    Object.keys(overrides).length === 0 ? "null" : JSON.stringify(overrides, null, 2);

  const sortedFlagKeys = data ? Object.keys(data.controlTypes).sort() : [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>Feature flags - {orgTitle}</DialogHeader>
        <DialogDescription>
          Org-level overrides. Unset flags inherit from global defaults.
        </DialogDescription>

        {data && (
          <div className={data.isManagedCloud ? "cursor-not-allowed" : undefined}>
            <CheckboxWithLabel
              variant="simple/small"
              label={
                data.isManagedCloud
                  ? "Unlock read-only flags (only in unmanaged cloud)"
                  : "Unlock read-only flags"
              }
              defaultChecked={unlocked}
              onChange={setUnlocked}
              disabled={data.isManagedCloud}
              className={data.isManagedCloud ? "pointer-events-none" : undefined}
            />
          </div>
        )}

        <div className="max-h-[60vh] overflow-y-auto">
          {isLoading ? (
            <div className="py-8 text-center text-sm text-text-dimmed">Loading flags...</div>
          ) : data ? (
            <div className="flex flex-col gap-1.5">
              {sortedFlagKeys.map((key) => {
                const control = data.controlTypes[key];
                const locked = isLocked(key);
                const globalValue = data.globalFlags[key as keyof typeof data.globalFlags];
                const isWorkerGroup = key === FEATURE_FLAG.defaultWorkerInstanceGroupId;
                const globalDisplay =
                  isWorkerGroup && data.workerGroupName && globalValue !== undefined
                    ? `${data.workerGroupName} (${String(globalValue).slice(0, 8)}...)`
                    : globalValue !== undefined
                      ? String(globalValue)
                      : "unset";

                const effect = ORG_LOCKED_FLAG_EFFECT[key as FeatureFlagKey];
                const invalidStored = data.invalidOrgFlags?.[key];
                const isInvalidStored = isUnchangedInvalidFlag(
                  key,
                  overrides,
                  data.invalidOrgFlags
                );

                if (isInvalidStored) {
                  return (
                    <div
                      key={key}
                      className="flex items-center justify-between rounded-md border border-error/30 bg-error/5 px-3 py-2.5"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm text-text-bright">{key}</div>
                        <div className="truncate text-xs text-text-dimmed">
                          org: {formatStoredValue(invalidStored)} (
                          {INVALID_VALUE_LABEL[key] ?? "invalid"}) · global: {globalDisplay}
                        </div>
                      </div>
                      {locked && effect === "derived" ? (
                        <LockClosedIcon className="size-4 text-text-faint" />
                      ) : (
                        <Button variant="minimal/small" onClick={() => unsetFlag(key)}>
                          unset
                        </Button>
                      )}
                    </div>
                  );
                }

                if (locked) {
                  const hasOrgValue = key in overrides;
                  const orgValue = overrides[key];
                  const orgWorkerGroup =
                    isWorkerGroup && hasOrgValue
                      ? data.workerGroups?.find((group) => group.id === orgValue)
                      : undefined;
                  const orgDisplay = orgWorkerGroup
                    ? `${orgWorkerGroup.name} (${String(orgValue).slice(0, 8)}...)`
                    : formatStoredValue(orgValue);
                  const canUnset = hasOrgValue && effect !== "derived";

                  return (
                    <div
                      key={key}
                      className={cn(
                        "flex items-center justify-between rounded-md border px-3 py-2.5",
                        hasOrgValue
                          ? "border-indigo-500/20 bg-indigo-500/5"
                          : "border-transparent bg-background-hover"
                      )}
                      title="Global-level setting - not editable per org"
                    >
                      <div className="min-w-0 flex-1">
                        <div
                          className={cn(
                            "truncate text-sm",
                            hasOrgValue ? "text-text-bright" : "text-text-dimmed"
                          )}
                        >
                          {key}
                        </div>
                        {hasOrgValue ? (
                          <div className="truncate text-xs text-text-dimmed">
                            org: {orgDisplay} ({effect ? LOCKED_EFFECT_LABEL[effect] : "stored"}) ·
                            global: {globalDisplay}
                          </div>
                        ) : (
                          <div className="text-xs text-text-dimmed">global: {globalDisplay}</div>
                        )}
                      </div>
                      {canUnset ? (
                        <Button variant="minimal/small" onClick={() => unsetFlag(key)}>
                          unset
                        </Button>
                      ) : (
                        <LockClosedIcon className="size-4 text-text-faint" />
                      )}
                    </div>
                  );
                }

                const isOverridden = key in overrides;

                if (key === FEATURE_FLAG.workerQueueEnvironmentOverrides) {
                  const enumOptions = (flag: string) => {
                    const flagControl = data.controlTypes[flag];
                    return flagControl?.type === "enum" ? flagControl.options : [];
                  };
                  return (
                    <div
                      key={key}
                      className={cn(
                        "flex flex-col gap-2 rounded-md border px-3 py-2.5",
                        isOverridden
                          ? "border-indigo-500/20 bg-indigo-500/5"
                          : "border-transparent bg-background-hover"
                      )}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div
                            className={cn(
                              "truncate text-sm",
                              isOverridden ? "text-text-bright" : "text-text-dimmed"
                            )}
                          >
                            {key}
                          </div>
                          <div className="text-xs text-text-dimmed">
                            Per field: environment id, then type, then the org flags above. A compat
                            of compute or container here also decides the compute backing swap.
                          </div>
                        </div>
                        <Button
                          variant="minimal/small"
                          onClick={() => unsetFlag(key)}
                          className={cn(!isOverridden && "invisible")}
                        >
                          unset
                        </Button>
                      </div>
                      <WorkerQueueEnvironmentOverridesControl
                        value={environmentOverrides}
                        environments={data.environments ?? []}
                        compatOptions={enumOptions(FEATURE_FLAG.workerQueueCompatibility)}
                        channelOptions={enumOptions(FEATURE_FLAG.workerQueueChannel)}
                        onChange={(val) => {
                          if (val === undefined) {
                            unsetFlag(key);
                          } else {
                            setFlagValue(key, val);
                          }
                        }}
                      />
                    </div>
                  );
                }

                return (
                  <div
                    key={key}
                    className={cn(
                      "flex items-center justify-between rounded-md border px-3 py-2.5",
                      isOverridden
                        ? "border-indigo-500/20 bg-indigo-500/5"
                        : "border-transparent bg-background-hover"
                    )}
                  >
                    <div className="min-w-0 flex-1">
                      <div
                        className={cn(
                          "truncate text-sm",
                          isOverridden ? "text-text-bright" : "text-text-dimmed"
                        )}
                      >
                        {key}
                      </div>
                      <div className="text-xs text-text-dimmed">global: {globalDisplay}</div>
                    </div>

                    <div className="flex items-center gap-2">
                      <Button
                        variant="minimal/small"
                        onClick={() => unsetFlag(key)}
                        className={cn(!isOverridden && "invisible")}
                      >
                        unset
                      </Button>

                      {isWorkerGroup && data.workerGroups ? (
                        <WorkerGroupControl
                          value={isOverridden ? (overrides[key] as string) : undefined}
                          workerGroups={data.workerGroups as WorkerGroup[]}
                          onChange={(val) => {
                            if (val === UNSET_VALUE) {
                              unsetFlag(key);
                            } else {
                              setFlagValue(key, val);
                            }
                          }}
                          dimmed={!isOverridden}
                        />
                      ) : control.type === "boolean" ? (
                        <BooleanControl
                          value={isOverridden ? (overrides[key] as boolean) : undefined}
                          onChange={(val) => setFlagValue(key, val)}
                          dimmed={!isOverridden}
                        />
                      ) : control.type === "enum" ? (
                        <EnumControl
                          value={isOverridden ? (overrides[key] as string) : undefined}
                          options={control.options}
                          onChange={(val) => {
                            if (val === UNSET_VALUE) {
                              unsetFlag(key);
                            } else {
                              setFlagValue(key, val);
                            }
                          }}
                          dimmed={!isOverridden}
                        />
                      ) : control.type === "number" ? (
                        <NumberControl
                          value={isOverridden ? (overrides[key] as number) : undefined}
                          min={control.min}
                          max={control.max}
                          onChange={(val) => {
                            if (val === undefined) {
                              unsetFlag(key);
                            } else {
                              setFlagValue(key, val);
                            }
                          }}
                          dimmed={!isOverridden}
                        />
                      ) : control.type === "string" ? (
                        <StringControl
                          value={isOverridden ? (overrides[key] as string) : ""}
                          onChange={(val) => {
                            if (val === "") {
                              unsetFlag(key);
                            } else {
                              setFlagValue(key, val);
                            }
                          }}
                          dimmed={!isOverridden}
                        />
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>

        {data && (
          <details className="mt-2">
            <summary className="cursor-pointer text-xs text-text-dimmed hover:text-text-bright">
              Preview JSON
            </summary>
            <pre className="mt-1 max-h-40 overflow-auto rounded bg-background-bright p-2 text-xs text-text-dimmed">
              {jsonPreview}
            </pre>
          </details>
        )}

        {hasIncompleteOverrides && (
          <Callout variant="error">Each environment override needs a compat or a channel.</Callout>
        )}

        {saveError && <Callout variant="error">{saveError}</Callout>}

        <DialogFooter>
          <Button variant="tertiary/small" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary/small"
            onClick={handleSave}
            disabled={!isDirty || isSaving || hasIncompleteOverrides}
          >
            {isSaving ? "Saving..." : "Save changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

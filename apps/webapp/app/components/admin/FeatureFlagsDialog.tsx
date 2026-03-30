import { useFetcher } from "@remix-run/react";
import { useEffect, useState } from "react";
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
import { FEATURE_FLAG, ORG_LOCKED_FLAGS, type FlagControlType } from "~/v3/featureFlags";
import {
  UNSET_VALUE,
  BooleanControl,
  EnumControl,
  StringControl,
  WorkerGroupControl,
  type WorkerGroup,
} from "./FlagControls";

type LoaderData = {
  org: { id: string; title: string; slug: string };
  orgFlags: Record<string, unknown>;
  globalFlags: Record<string, unknown>;
  controlTypes: Record<string, FlagControlType>;
  workerGroupName?: string;
  workerGroups?: WorkerGroup[];
  isManagedCloud?: boolean;
};

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

  const [overrides, setOverrides] = useState<Record<string, unknown>>({});
  const [initialOverrides, setInitialOverrides] = useState<Record<string, unknown>>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [unlocked, setUnlocked] = useState(false);

  const isLocked = (key: string) => !unlocked && ORG_LOCKED_FLAGS.includes(key);

  useEffect(() => {
    if (open && orgId) {
      setSaveError(null);
      setOverrides({});
      setInitialOverrides({});
      loadFetcher.load(`/admin/api/v2/orgs/${orgId}/feature-flags`);
    }
  }, [open, orgId]);

  useEffect(() => {
    if (loadFetcher.data) {
      const loaded = loadFetcher.data.orgFlags ?? {};
      setOverrides({ ...loaded });
      setInitialOverrides({ ...loaded });
    }
  }, [loadFetcher.data]);

  useEffect(() => {
    if (saveFetcher.data?.success) {
      onOpenChange(false);
    } else if (saveFetcher.data?.error) {
      setSaveError(saveFetcher.data.error);
    }
  }, [saveFetcher.data]);

  const isDirty = stableStringify(overrides) !== stableStringify(initialOverrides);

  const setFlagValue = (key: string, value: unknown) => {
    setOverrides((prev) => ({ ...prev, [key]: value }));
  };

  const unsetFlag = (key: string) => {
    setOverrides((prev) => {
      const next = { ...prev };
      delete next[key];
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

                if (locked) {
                  return (
                    <div
                      key={key}
                      className="flex items-center justify-between rounded-md border border-transparent bg-charcoal-750 px-3 py-2.5"
                      title="Global-level setting - not editable per org"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm text-text-dimmed">{key}</div>
                        <div className="text-xs text-charcoal-400">global: {globalDisplay}</div>
                      </div>
                      <LockClosedIcon className="size-4 text-charcoal-500" />
                    </div>
                  );
                }

                const isOverridden = key in overrides;

                return (
                  <div
                    key={key}
                    className={cn(
                      "flex items-center justify-between rounded-md border px-3 py-2.5",
                      isOverridden
                        ? "border-indigo-500/20 bg-indigo-500/5"
                        : "border-transparent bg-charcoal-750"
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
                      <div className="text-xs text-charcoal-400">global: {globalDisplay}</div>
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
            <pre className="mt-1 max-h-40 overflow-auto rounded bg-charcoal-800 p-2 text-xs text-text-dimmed">
              {jsonPreview}
            </pre>
          </details>
        )}

        {saveError && <Callout variant="error">{saveError}</Callout>}

        <DialogFooter>
          <Button variant="tertiary/small" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary/small" onClick={handleSave} disabled={!isDirty || isSaving}>
            {isSaving ? "Saving..." : "Save changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

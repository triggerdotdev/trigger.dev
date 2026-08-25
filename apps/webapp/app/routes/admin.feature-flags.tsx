import { useFetcher } from "@remix-run/react";
import { useEffect, useState } from "react";
import stableStringify from "json-stable-stringify";
import { json } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { LockClosedIcon } from "@heroicons/react/20/solid";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { dashboardAction, dashboardLoader } from "~/services/routeBuilders/dashboardBuilder";
import {
  FEATURE_FLAG,
  GLOBAL_LOCKED_FLAGS,
  type FeatureFlagKey,
  type FlagControlType,
  getAllFlagControlTypes,
  lockedFlagsInPayload,
  validatePartialFeatureFlags,
} from "~/v3/featureFlags";
import { snapshotStoreFlagSaveError } from "~/v3/snapshotStoreFlagGuard.server";
import { flags as getGlobalFlags, replaceGlobalFeatureFlags } from "~/v3/featureFlags.server";
import { featuresForRequest } from "~/features.server";
import { Button } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import { CheckboxWithLabel } from "~/components/primitives/Checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogDescription,
  DialogFooter,
} from "~/components/primitives/Dialog";
import { cn } from "~/utils/cn";
import { buildFlagChangeList } from "~/components/admin/flagChangeList";
import {
  UNSET_VALUE,
  BooleanControl,
  EnumControl,
  NumberControl,
  StringControl,
  WorkerGroupControl,
  type WorkerGroup,
} from "~/components/admin/FlagControls";

/** What the page posts to the action. See the note on payloadSchema. */
type SaveFlagsBody = {
  flags: Record<string, unknown>;
  unlockLockedFlags: boolean;
};

export const loader = dashboardLoader(
  { authorization: { requireSuper: true } },
  async ({ request }) => {
    const [globalFlags, workerGroups] = await Promise.all([
      getGlobalFlags(),
      prisma.workerInstanceGroup.findMany({
        select: { id: true, name: true },
        orderBy: { name: "asc" },
      }),
    ]);
    const controlTypes = getAllFlagControlTypes();

    // Resolve env-based defaults for locked flags
    const resolvedDefaults: Record<string, string> = {
      [FEATURE_FLAG.taskEventRepository]: env.EVENT_REPOSITORY_DEFAULT_STORE,
    };

    // Look up worker group name if the flag is set
    const workerGroupId = (globalFlags as Record<string, unknown>)?.[
      FEATURE_FLAG.defaultWorkerInstanceGroupId
    ];
    const workerGroupName =
      typeof workerGroupId === "string"
        ? workerGroups.find((wg) => wg.id === workerGroupId)?.name
        : undefined;

    const { isManagedCloud } = featuresForRequest(request);

    return typedjson({
      globalFlags,
      controlTypes,
      resolvedDefaults,
      workerGroupName,
      workerGroups,
      isManagedCloud,
    });
  }
);

export const action = dashboardAction(
  { authorization: { requireSuper: true } },
  async ({ request }) => {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid JSON body" }, { status: 400 });
    }

    // The zod schema leaves unlockLockedFlags optional so a tab opened before this shipped still
    // saves, defaulting to the safe answer. SaveFlagsBody keeps it required for our own client, so
    // dropping it from the page is a compile error rather than a silently disabled unlock.
    const payloadSchema = z.object({
      flags: z.record(z.unknown()),
      // The page only submits the flags it is managing, so an omitted key is ambiguous for the
      // locked flags: this says whether the admin unlocked them and is therefore authoritative
      // over them too.
      unlockLockedFlags: z.boolean().optional(),
    });
    const parsed = payloadSchema.safeParse(body);
    if (!parsed.success) {
      return json({ error: "Invalid payload" }, { status: 400 });
    }

    const { isManagedCloud } = featuresForRequest(request);

    const lockedInPayload = lockedFlagsInPayload(Object.keys(parsed.data.flags), isManagedCloud);
    if (lockedInPayload.length > 0) {
      return json(
        { error: `Cannot modify locked flags: ${lockedInPayload.join(", ")}` },
        { status: 400 }
      );
    }

    const validationResult = validatePartialFeatureFlags(parsed.data.flags);
    if (!validationResult.success) {
      return json(
        { error: "Invalid feature flags", details: validationResult.error.issues },
        { status: 400 }
      );
    }

    const snapshotStoreError = snapshotStoreFlagSaveError(parsed.data.flags, {
      redisHostConfigured: !!env.RUN_ENGINE_SNAPSHOT_STORE_REDIS_HOST,
    });
    if (snapshotStoreError) {
      return json({ error: snapshotStoreError }, { status: 400 });
    }

    await replaceGlobalFeatureFlags(prisma, {
      requestedFlags: validationResult.data as Record<string, unknown>,
      catalogKeys: Object.keys(getAllFlagControlTypes()) as FeatureFlagKey[],
      isManagedCloud,
      unlockLockedFlags: parsed.data.unlockLockedFlags ?? false,
      graceMs: env.RUN_OPS_MINT_FLIP_GRACE_MS,
    });

    return json({ success: true });
  }
);

export default function AdminFeatureFlagsRoute() {
  const {
    globalFlags,
    controlTypes,
    resolvedDefaults,
    workerGroupName,
    workerGroups,
    isManagedCloud,
  } = useTypedLoaderData<typeof loader>();
  const saveFetcher = useFetcher<{ success?: boolean; error?: string }>();

  const [values, setValues] = useState<Record<string, unknown>>({});
  const [initialValues, setInitialValues] = useState<Record<string, unknown>>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [unlocked, setUnlocked] = useState(false);

  const isLocked = (key: string) => !unlocked && GLOBAL_LOCKED_FLAGS.includes(key);

  useEffect(() => {
    const loaded = (globalFlags ?? {}) as Record<string, unknown>;
    // Only track editable flags in state
    const editable: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(loaded)) {
      if (unlocked || !GLOBAL_LOCKED_FLAGS.includes(key)) {
        editable[key] = value;
      }
    }
    // oxlint-disable-next-line react/set-state-in-effect -- This effect intentionally synchronizes route state after an external or lifecycle change.
    setValues({ ...editable });
    setInitialValues({ ...editable });
  }, [globalFlags, unlocked]);

  useEffect(() => {
    if (saveFetcher.data?.success) {
      // oxlint-disable-next-line react/set-state-in-effect -- This effect intentionally synchronizes route state after an external or lifecycle change.
      setSaveError(null);
      setConfirmOpen(false);
    } else if (saveFetcher.data?.error) {
      setSaveError(saveFetcher.data.error);
    }
  }, [saveFetcher.data]);

  const isDirty = stableStringify(values) !== stableStringify(initialValues);
  const isSaving = saveFetcher.state === "submitting";

  const setFlagValue = (key: string, value: unknown) => {
    setValues((prev) => ({ ...prev, [key]: value }));
  };

  const unsetFlag = (key: string) => {
    setValues((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const handleSave = () => {
    const body: SaveFlagsBody = { flags: values, unlockLockedFlags: unlocked };
    saveFetcher.submit(JSON.stringify(body), {
      method: "POST",
      encType: "application/json",
    });
  };

  const typedControlTypes = controlTypes as Record<string, FlagControlType>;
  const typedResolvedDefaults = resolvedDefaults as Record<string, string>;
  const allFlags = (globalFlags ?? {}) as Record<string, unknown>;
  const sortedFlagKeys = Object.keys(typedControlTypes).sort();
  const workerGroupMap = new Map((workerGroups as WorkerGroup[]).map((wg) => [wg.id, wg.name]));

  const resolveWorkerGroupDisplay = (id: string) => {
    const name = workerGroupMap.get(id);
    return name ? `${name} (${id.slice(0, 8)}...)` : id;
  };

  return (
    <main className="flex h-full min-w-0 flex-1 flex-col overflow-y-auto px-4 pb-4 lg:order-last">
      <div className="max-w-2xl space-y-4">
        <Callout variant="warning">
          These are global feature flags that affect every organization on this instance. Changing
          values here is a dangerous operation and should rarely be done - prefer org-level
          overrides where possible. Org-level overrides take precedence; when a flag isn't set, each
          consumer uses its own default.
        </Callout>

        <div className={isManagedCloud ? "cursor-not-allowed" : undefined}>
          <CheckboxWithLabel
            variant="simple/small"
            label={
              isManagedCloud
                ? "Unlock read-only flags (only in unmanaged cloud)"
                : "Unlock read-only flags"
            }
            defaultChecked={unlocked}
            onChange={setUnlocked}
            disabled={isManagedCloud}
            className={isManagedCloud ? "pointer-events-none" : undefined}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          {sortedFlagKeys.map((key) => {
            const control = typedControlTypes[key];
            const locked = isLocked(key);

            if (locked) {
              return (
                <LockedFlagRow
                  key={key}
                  flagKey={key}
                  value={allFlags[key]}
                  resolvedDefault={typedResolvedDefaults[key]}
                  workerGroupName={workerGroupName as string | undefined}
                />
              );
            }

            const isSet = key in values;
            const isWorkerGroup = key === FEATURE_FLAG.defaultWorkerInstanceGroupId;

            return (
              <div
                key={key}
                className={cn(
                  "flex items-center justify-between rounded-md border px-3 py-2.5",
                  isSet
                    ? "border-indigo-500/20 bg-indigo-500/5"
                    : "border-transparent bg-background-hover"
                )}
              >
                <div className="min-w-0 flex-1">
                  <div
                    className={cn(
                      "truncate text-sm",
                      isSet ? "text-text-bright" : "text-text-dimmed"
                    )}
                  >
                    {isWorkerGroup ? "defaultWorkerInstanceGroup" : key}
                  </div>
                  <div className="text-xs text-text-dimmed">
                    {isSet
                      ? isWorkerGroup
                        ? resolveWorkerGroupDisplay(values[key] as string)
                        : `value: ${String(values[key])}`
                      : typedResolvedDefaults[key]
                        ? `${typedResolvedDefaults[key]} (from env)`
                        : "not set"}
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <Button
                    variant="minimal/small"
                    onClick={() => unsetFlag(key)}
                    className={cn(!isSet && "invisible")}
                  >
                    unset
                  </Button>

                  {isWorkerGroup ? (
                    <WorkerGroupControl
                      value={isSet ? (values[key] as string) : undefined}
                      workerGroups={workerGroups as WorkerGroup[]}
                      onChange={(val) => {
                        if (val === UNSET_VALUE) {
                          unsetFlag(key);
                        } else {
                          setFlagValue(key, val);
                        }
                      }}
                      dimmed={!isSet}
                    />
                  ) : (
                    <>
                      {control.type === "boolean" && (
                        <BooleanControl
                          value={isSet ? (values[key] as boolean) : undefined}
                          onChange={(val) => setFlagValue(key, val)}
                          dimmed={!isSet}
                        />
                      )}

                      {control.type === "enum" && (
                        <EnumControl
                          value={isSet ? (values[key] as string) : undefined}
                          options={control.options}
                          onChange={(val) => {
                            if (val === UNSET_VALUE) {
                              unsetFlag(key);
                            } else {
                              setFlagValue(key, val);
                            }
                          }}
                          dimmed={!isSet}
                        />
                      )}

                      {control.type === "number" && (
                        <NumberControl
                          value={isSet ? (values[key] as number) : undefined}
                          min={control.min}
                          max={control.max}
                          onChange={(val) => {
                            if (val === undefined) {
                              unsetFlag(key);
                            } else {
                              setFlagValue(key, val);
                            }
                          }}
                          dimmed={!isSet}
                        />
                      )}

                      {control.type === "string" && (
                        <StringControl
                          value={isSet ? (values[key] as string) : ""}
                          onChange={(val) => {
                            if (val === "") {
                              unsetFlag(key);
                            } else {
                              setFlagValue(key, val);
                            }
                          }}
                          dimmed={!isSet}
                        />
                      )}
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {saveError && <Callout variant="error">{saveError}</Callout>}

        <div className="flex justify-end gap-2">
          {isDirty && (
            <Button variant="tertiary/small" onClick={() => setValues({ ...initialValues })}>
              Discard
            </Button>
          )}
          <Button
            variant="primary/small"
            onClick={() => setConfirmOpen(true)}
            disabled={!isDirty || isSaving}
          >
            Review changes
          </Button>
        </div>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        initialValues={initialValues}
        storedValues={allFlags}
        newValues={values}
        controlTypes={typedControlTypes}
        lockedKeys={unlocked ? [] : GLOBAL_LOCKED_FLAGS}
        onConfirm={handleSave}
        isSaving={isSaving}
        saveError={saveError}
      />
    </main>
  );
}

// --- Locked Flag Row ---

function LockedFlagRow({
  flagKey,
  value,
  resolvedDefault,
  workerGroupName,
}: {
  flagKey: string;
  value: unknown;
  resolvedDefault: string | undefined;
  workerGroupName: string | undefined;
}) {
  const isSet = value !== undefined;
  const isWorkerGroup = flagKey === FEATURE_FLAG.defaultWorkerInstanceGroupId;

  let displayValue: string;
  if (isSet) {
    if (isWorkerGroup && workerGroupName) {
      displayValue = `${workerGroupName} (${String(value).slice(0, 8)}...)`;
    } else {
      displayValue = String(value);
    }
  } else if (resolvedDefault) {
    displayValue = `${resolvedDefault} (from env)`;
  } else {
    displayValue = "not set (required)";
  }

  return (
    <div
      className={cn(
        "flex items-center justify-between rounded-md border px-3 py-2.5",
        isSet ? "border-indigo-500/20 bg-indigo-500/5" : "border-transparent bg-background-hover"
      )}
      title="Managed via database - not editable from this UI"
    >
      <div className="min-w-0 flex-1">
        <div className={cn("truncate text-sm", isSet ? "text-text-bright" : "text-text-dimmed")}>
          {isWorkerGroup ? "defaultWorkerInstanceGroup" : flagKey}
        </div>
        <div className="text-xs text-text-dimmed">{displayValue}</div>
      </div>

      <LockClosedIcon className="size-4 text-text-faint" />
    </div>
  );
}

// --- Confirmation Dialog with Diff ---

function ConfirmDialog({
  open,
  onOpenChange,
  initialValues,
  storedValues,
  newValues,
  controlTypes,
  lockedKeys,
  onConfirm,
  isSaving,
  saveError,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialValues: Record<string, unknown>;
  storedValues: Record<string, unknown>;
  newValues: Record<string, unknown>;
  controlTypes: Record<string, FlagControlType>;
  lockedKeys: readonly string[];
  onConfirm: () => void;
  isSaving: boolean;
  saveError: string | null;
}) {
  const editableKeys = Object.keys(controlTypes)
    .filter((key) => !lockedKeys.includes(key))
    .sort();

  const changes = buildFlagChangeList({
    editableKeys,
    lockedKeys,
    initialValues,
    storedValues,
    newValues,
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>Confirm feature flag changes</DialogHeader>
        <DialogDescription>
          These changes affect all organizations globally. Please review carefully.
        </DialogDescription>

        <div className="flex max-h-[50vh] flex-col gap-2 overflow-y-auto pb-2">
          {changes.length === 0 ? (
            <p className="text-sm text-text-dimmed">No changes to apply.</p>
          ) : (
            changes.map((change) => (
              <div
                key={change.key}
                className="rounded-md border border-border-bright bg-background-bright px-3 py-2 font-mono text-xs"
              >
                <div className="font-sans text-sm text-text-bright">{change.key}</div>
                {change.type === "added" && (
                  <div className="mt-1 text-green-400 system:text-green-700">+ {change.newVal}</div>
                )}
                {change.type === "removed" && (
                  <div className="mt-1 text-red-400">- {change.oldVal} (unset)</div>
                )}
                {change.type === "changed" && (
                  <>
                    <div className="mt-1 text-red-400">- {change.oldVal}</div>
                    <div className="text-green-400 system:text-green-700">+ {change.newVal}</div>
                  </>
                )}
              </div>
            ))
          )}
        </div>

        {saveError && <Callout variant="error">{saveError}</Callout>}

        <DialogFooter>
          <Button variant="tertiary/small" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="danger/small"
            onClick={onConfirm}
            disabled={isSaving || changes.length === 0}
          >
            {isSaving ? "Saving..." : "Apply changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

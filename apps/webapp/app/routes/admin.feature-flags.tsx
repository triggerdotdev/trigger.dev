import { useFetcher } from "@remix-run/react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/server-runtime";
import { useEffect, useState } from "react";
import stableStringify from "json-stable-stringify";
import { json } from "@remix-run/server-runtime";
import { redirect, typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { LockClosedIcon } from "@heroicons/react/20/solid";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { requireUser } from "~/services/session.server";
import {
  FEATURE_FLAG,
  GLOBAL_LOCKED_FLAGS,
  type FlagControlType,
  getAllFlagControlTypes,
  validatePartialFeatureFlags,
} from "~/v3/featureFlags";
import { flags as getGlobalFlags } from "~/v3/featureFlags.server";
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
import {
  UNSET_VALUE,
  BooleanControl,
  EnumControl,
  StringControl,
  WorkerGroupControl,
  type WorkerGroup,
} from "~/components/admin/FlagControls";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const user = await requireUser(request);
  if (!user.admin) {
    return redirect("/");
  }

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
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const user = await requireUser(request);
  if (!user.admin) {
    throw new Response("Unauthorized", { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const payloadSchema = z.object({ flags: z.record(z.unknown()) });
  const parsed = payloadSchema.safeParse(body);
  if (!parsed.success) {
    return json({ error: "Invalid payload" }, { status: 400 });
  }

  const { isManagedCloud } = featuresForRequest(request);

  // On managed cloud, reject if payload includes locked flags
  if (isManagedCloud) {
    const lockedInPayload = Object.keys(parsed.data.flags).filter((key) =>
      GLOBAL_LOCKED_FLAGS.includes(key)
    );
    if (lockedInPayload.length > 0) {
      return json(
        { error: `Cannot modify locked flags: ${lockedInPayload.join(", ")}` },
        { status: 400 }
      );
    }
  }

  const validationResult = validatePartialFeatureFlags(parsed.data.flags);
  if (!validationResult.success) {
    return json(
      { error: "Invalid feature flags", details: validationResult.error.issues },
      { status: 400 }
    );
  }

  const validatedFlags = validationResult.data as Record<string, unknown>;
  const controlTypes = getAllFlagControlTypes();
  const catalogKeys = Object.keys(controlTypes);

  const keysToDelete: string[] = [];
  const upsertOps: ReturnType<typeof prisma.featureFlag.upsert>[] = [];

  for (const key of catalogKeys) {
    if (key in validatedFlags) {
      upsertOps.push(
        prisma.featureFlag.upsert({
          where: { key },
          create: { key, value: validatedFlags[key] as any },
          update: { value: validatedFlags[key] as any },
        })
      );
    } else {
      // On cloud, never delete locked flags (they're not in the payload
      // because the UI doesn't include them). Locally, delete everything
      // the user didn't include - full control.
      const isProtected = isManagedCloud && GLOBAL_LOCKED_FLAGS.includes(key);
      if (!isProtected) {
        keysToDelete.push(key);
      }
    }
  }

  await prisma.$transaction([
    ...upsertOps,
    ...(keysToDelete.length > 0
      ? [prisma.featureFlag.deleteMany({ where: { key: { in: keysToDelete } } })]
      : []),
  ]);

  return json({ success: true });
};

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
      if (!isLocked(key)) {
        editable[key] = value;
      }
    }
    setValues({ ...editable });
    setInitialValues({ ...editable });
  }, [globalFlags, unlocked]);

  useEffect(() => {
    if (saveFetcher.data?.success) {
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
    saveFetcher.submit(JSON.stringify({ flags: values }), {
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
          overrides where possible. Org-level overrides take precedence; when a flag isn't set,
          each consumer uses its own default.
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
                    : "border-transparent bg-charcoal-750"
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
                  <div className="text-xs text-charcoal-400">
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
        newValues={values}
        controlTypes={typedControlTypes}
        lockedKeys={unlocked ? [] : GLOBAL_LOCKED_FLAGS}
        onConfirm={handleSave}
        isSaving={isSaving}
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
        isSet ? "border-indigo-500/20 bg-indigo-500/5" : "border-transparent bg-charcoal-750"
      )}
      title="Managed via database - not editable from this UI"
    >
      <div className="min-w-0 flex-1">
        <div
          className={cn("truncate text-sm", isSet ? "text-text-bright" : "text-text-dimmed")}
        >
          {isWorkerGroup ? "defaultWorkerInstanceGroup" : flagKey}
        </div>
        <div className="text-xs text-charcoal-400">{displayValue}</div>
      </div>

      <LockClosedIcon className="size-4 text-charcoal-500" />
    </div>
  );
}

// --- Confirmation Dialog with Diff ---

function ConfirmDialog({
  open,
  onOpenChange,
  initialValues,
  newValues,
  controlTypes,
  lockedKeys,
  onConfirm,
  isSaving,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialValues: Record<string, unknown>;
  newValues: Record<string, unknown>;
  controlTypes: Record<string, FlagControlType>;
  lockedKeys: readonly string[];
  onConfirm: () => void;
  isSaving: boolean;
}) {
  const editableKeys = Object.keys(controlTypes)
    .filter((key) => !lockedKeys.includes(key))
    .sort();

  type Change =
    | { key: string; type: "added"; newVal: string }
    | { key: string; type: "removed"; oldVal: string }
    | { key: string; type: "changed"; oldVal: string; newVal: string };

  const changes = editableKeys.flatMap<Change>((key) => {
    const wasSet = key in initialValues;
    const isSet = key in newValues;
    const oldVal = initialValues[key];
    const newVal = newValues[key];

    if (!wasSet && !isSet) return [];
    if (wasSet && isSet && stableStringify(oldVal) === stableStringify(newVal)) return [];

    if (!wasSet && isSet) {
      return [{ key, type: "added" as const, newVal: String(newVal) }];
    }
    if (wasSet && !isSet) {
      return [{ key, type: "removed" as const, oldVal: String(oldVal) }];
    }
    return [
      {
        key,
        type: "changed" as const,
        oldVal: String(oldVal),
        newVal: String(newVal),
      },
    ];
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>Confirm feature flag changes</DialogHeader>
        <DialogDescription>
          These changes affect all organizations globally. Please review carefully.
        </DialogDescription>

        <div className="flex flex-col gap-2 pb-2">
          {changes.length === 0 ? (
            <p className="text-sm text-text-dimmed">No changes to apply.</p>
          ) : (
            changes.map((change) => (
              <div
                key={change.key}
                className="rounded-md border border-charcoal-600 bg-charcoal-800 px-3 py-2 font-mono text-xs"
              >
                <div className="font-sans text-sm text-text-bright">{change.key}</div>
                {change.type === "added" && (
                  <div className="mt-1 text-green-400">+ {change.newVal}</div>
                )}
                {change.type === "removed" && (
                  <div className="mt-1 text-red-400">- {change.oldVal} (unset)</div>
                )}
                {change.type === "changed" && (
                  <>
                    <div className="mt-1 text-red-400">- {change.oldVal}</div>
                    <div className="text-green-400">+ {change.newVal}</div>
                  </>
                )}
              </div>
            ))
          )}
        </div>

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

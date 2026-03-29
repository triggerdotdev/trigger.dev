import { useFetcher } from "@remix-run/react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/server-runtime";
import { useEffect, useState } from "react";
import stableStringify from "json-stable-stringify";
import { json } from "@remix-run/server-runtime";
import { redirect, typedjson, useTypedLoaderData } from "remix-typedjson";
import { prisma } from "~/db.server";
import { requireUser } from "~/services/session.server";
import {
  FEATURE_FLAG,
  flags as getGlobalFlags,
  getAllFlagControlTypes,
  validatePartialFeatureFlags,
} from "~/v3/featureFlags.server";
import type { FlagControlType } from "~/v3/featureFlags.server";
import { Button } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
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
} from "~/components/admin/FlagControls";
import { Select, SelectItem } from "~/components/primitives/Select";

type WorkerGroup = { id: string; name: string };

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

  return typedjson({ globalFlags, controlTypes, workerGroups });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const user = await requireUser(request);
  if (!user.admin) {
    throw new Response("Unauthorized", { status: 403 });
  }

  const body = await request.json();

  if (
    typeof body !== "object" ||
    body === null ||
    Array.isArray(body) ||
    typeof body.flags !== "object" ||
    body.flags === null ||
    Array.isArray(body.flags)
  ) {
    return json({ error: "Invalid payload" }, { status: 400 });
  }

  const newFlags = body.flags as Record<string, unknown>;
  const validationResult = validatePartialFeatureFlags(newFlags);
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
      keysToDelete.push(key);
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
  const { globalFlags, controlTypes, workerGroups } = useTypedLoaderData<typeof loader>();
  const saveFetcher = useFetcher<{ success?: boolean; error?: string }>();

  const [values, setValues] = useState<Record<string, unknown>>({});
  const [initialValues, setInitialValues] = useState<Record<string, unknown>>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  useEffect(() => {
    const loaded = (globalFlags ?? {}) as Record<string, unknown>;
    setValues({ ...loaded });
    setInitialValues({ ...loaded });
  }, [globalFlags]);

  useEffect(() => {
    if (saveFetcher.data?.success) {
      setSaveError(null);
      setInitialValues({ ...values });
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

  const workerGroupMap = new Map(
    (workerGroups as WorkerGroup[]).map((wg) => [wg.id, wg.name])
  );

  const resolveWorkerGroupDisplay = (id: string) => {
    const name = workerGroupMap.get(id);
    return name ? `${name} (${id.slice(0, 8)}...)` : id;
  };

  const sortedFlagKeys = Object.keys(controlTypes as Record<string, FlagControlType>).sort();

  return (
    <main className="flex h-full min-w-0 flex-1 flex-col overflow-y-auto px-4 pb-4 lg:order-last">
      <div className="max-w-2xl space-y-4">
        <p className="text-sm text-text-dimmed">
          Global defaults for all organizations. Org-level overrides take precedence.
          When not set, each consumer uses its own default.
        </p>

        <div className="flex flex-col gap-1.5">
          {sortedFlagKeys.map((key) => {
            const control = (controlTypes as Record<string, FlagControlType>)[key];
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
            <Button
              variant="tertiary/small"
              onClick={() => setValues({ ...initialValues })}
            >
              Discard
            </Button>
          )}
          <Button
            variant="primary/small"
            onClick={() => setConfirmOpen(true)}
            disabled={!isDirty || isSaving}
          >
            Review Changes
          </Button>
        </div>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        initialValues={initialValues}
        newValues={values}
        controlTypes={controlTypes as Record<string, FlagControlType>}
        workerGroupMap={workerGroupMap}
        onConfirm={handleSave}
        isSaving={isSaving}
      />
    </main>
  );
}

// --- Worker Group Select ---

function WorkerGroupControl({
  value,
  workerGroups,
  onChange,
  dimmed,
}: {
  value: string | undefined;
  workerGroups: WorkerGroup[];
  onChange: (val: string) => void;
  dimmed: boolean;
}) {
  const items = [UNSET_VALUE, ...workerGroups.map((wg) => wg.id)];

  return (
    <Select
      variant="tertiary/small"
      value={value ?? UNSET_VALUE}
      setValue={onChange}
      items={items}
      text={(val) => {
        if (val === UNSET_VALUE) return "unset";
        const wg = workerGroups.find((w) => w.id === val);
        return wg ? wg.name : val;
      }}
      className={cn(dimmed && "opacity-50")}
    >
      {(items) =>
        items.map((item) => {
          const wg = workerGroups.find((w) => w.id === item);
          return (
            <SelectItem key={item} value={item}>
              {item === UNSET_VALUE ? "unset" : wg ? wg.name : item}
            </SelectItem>
          );
        })
      }
    </Select>
  );
}

// --- Confirmation Dialog with Diff ---

function ConfirmDialog({
  open,
  onOpenChange,
  initialValues,
  newValues,
  controlTypes,
  workerGroupMap,
  onConfirm,
  isSaving,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialValues: Record<string, unknown>;
  newValues: Record<string, unknown>;
  controlTypes: Record<string, FlagControlType>;
  workerGroupMap: Map<string, string>;
  onConfirm: () => void;
  isSaving: boolean;
}) {
  const allKeys = Object.keys(controlTypes).sort();

  type Change =
    | { key: string; type: "added"; newVal: string }
    | { key: string; type: "removed"; oldVal: string }
    | { key: string; type: "changed"; oldVal: string; newVal: string };

  const changes = allKeys.flatMap<Change>((key) => {
    const wasSet = key in initialValues;
    const isSet = key in newValues;
    const oldVal = initialValues[key];
    const newVal = newValues[key];

    if (!wasSet && !isSet) return [];
    if (wasSet && isSet && stableStringify(oldVal) === stableStringify(newVal)) return [];

    const displayKey =
      key === FEATURE_FLAG.defaultWorkerInstanceGroupId ? "defaultWorkerInstanceGroup" : key;

    const formatVal = (val: unknown) => {
      if (key === FEATURE_FLAG.defaultWorkerInstanceGroupId && typeof val === "string") {
        const name = workerGroupMap.get(val);
        return name ? `${name} (${val.slice(0, 8)}...)` : String(val);
      }
      return String(val);
    };

    if (!wasSet && isSet) {
      return [{ key: displayKey, type: "added" as const, newVal: formatVal(newVal) }];
    }
    if (wasSet && !isSet) {
      return [{ key: displayKey, type: "removed" as const, oldVal: formatVal(oldVal) }];
    }
    return [
      {
        key: displayKey,
        type: "changed" as const,
        oldVal: formatVal(oldVal),
        newVal: formatVal(newVal),
      },
    ];
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>Confirm Feature Flag Changes</DialogHeader>
        <DialogDescription>
          These changes affect all organizations globally. Please review carefully.
        </DialogDescription>

        <div className="flex flex-col gap-2 py-2">
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
            {isSaving ? "Saving..." : "Apply Changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

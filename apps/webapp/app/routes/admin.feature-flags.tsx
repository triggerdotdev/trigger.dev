import { useFetcher } from "@remix-run/react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/server-runtime";
import { useEffect, useState } from "react";
import stableStringify from "json-stable-stringify";
import { json } from "@remix-run/server-runtime";
import { redirect, typedjson, useTypedLoaderData } from "remix-typedjson";
import { prisma } from "~/db.server";
import { requireUser } from "~/services/session.server";
import {
  flags as getGlobalFlags,
  getAllFlagControlTypes,
  validatePartialFeatureFlags,
} from "~/v3/featureFlags.server";
import type { FlagControlType } from "~/v3/featureFlags.server";
import { Button } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import { cn } from "~/utils/cn";
import { UNSET_VALUE, BooleanControl, EnumControl, StringControl } from "~/components/admin/FlagControls";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const user = await requireUser(request);
  if (!user.admin) {
    return redirect("/");
  }

  const globalFlags = await getGlobalFlags();
  const controlTypes = getAllFlagControlTypes();

  return typedjson({ globalFlags, controlTypes });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const user = await requireUser(request);
  if (!user.admin) {
    throw new Response("Unauthorized", { status: 403 });
  }

  const body = await request.json();
  const { flags: newFlags } = body as { flags: Record<string, unknown> };

  const controlTypes = getAllFlagControlTypes();
  const catalogKeys = Object.keys(controlTypes);

  // For each catalog key: if value is present in newFlags, upsert it. If absent, delete the row.
  for (const key of catalogKeys) {
    if (key in newFlags) {
      const value = newFlags[key];
      // Validate the value against its schema
      const partial = { [key]: value };
      const result = validatePartialFeatureFlags(partial);
      if (result.success) {
        await prisma.featureFlag.upsert({
          where: { key },
          create: { key, value: value as any },
          update: { value: value as any },
        });
      }
    } else {
      // Unset - delete the row if it exists
      await prisma.featureFlag.deleteMany({ where: { key } });
    }
  }

  return json({ success: true });
};

export default function AdminFeatureFlagsRoute() {
  const { globalFlags, controlTypes } = useTypedLoaderData<typeof loader>();
  const saveFetcher = useFetcher<{ success?: boolean; error?: string }>();

  const [values, setValues] = useState<Record<string, unknown>>({});
  const [initialValues, setInitialValues] = useState<Record<string, unknown>>({});
  const [saveError, setSaveError] = useState<string | null>(null);

  // Sync loader data into local state
  useEffect(() => {
    const loaded = (globalFlags ?? {}) as Record<string, unknown>;
    setValues({ ...loaded });
    setInitialValues({ ...loaded });
  }, [globalFlags]);

  useEffect(() => {
    if (saveFetcher.data?.success) {
      setSaveError(null);
      // Update initial to match saved state
      setInitialValues({ ...values });
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
                    {key}
                  </div>
                  <div className="text-xs text-charcoal-400">
                    {isSet ? `value: ${String(values[key])}` : "not set"}
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
                </div>
              </div>
            );
          })}
        </div>

        {saveError && <Callout variant="error">{saveError}</Callout>}

        <div className="flex justify-end gap-2">
          <Button
            variant="primary/small"
            onClick={handleSave}
            disabled={!isDirty || isSaving}
          >
            {isSaving ? "Saving..." : "Save Changes"}
          </Button>
        </div>
      </div>
    </main>
  );
}

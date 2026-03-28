import { useFetcher } from "@remix-run/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "~/components/primitives/Dialog";
import { Button } from "~/components/primitives/Buttons";
import { Switch } from "~/components/primitives/Switch";
import { Select, SelectItem } from "~/components/primitives/Select";
import { Input } from "~/components/primitives/Input";
import { cn } from "~/utils/cn";
import type { FlagControlType } from "~/v3/featureFlags.server";

type LoaderData = {
  org: { id: string; title: string; slug: string };
  orgFlags: Record<string, unknown>;
  globalFlags: Record<string, unknown>;
  controlTypes: Record<string, FlagControlType>;
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

  // Local state for edits - keyed by flag name, value is the override or undefined (unset)
  const [overrides, setOverrides] = useState<Record<string, unknown>>({});
  const [initialOverrides, setInitialOverrides] = useState<Record<string, unknown>>({});

  // Load flags when dialog opens
  useEffect(() => {
    if (open && orgId) {
      loadFetcher.load(`/admin/api/orgs/${orgId}/feature-flags`);
    }
  }, [open, orgId]);

  // Sync loaded data into local state
  useEffect(() => {
    if (loadFetcher.data) {
      const loaded = loadFetcher.data.orgFlags ?? {};
      setOverrides({ ...loaded });
      setInitialOverrides({ ...loaded });
    }
  }, [loadFetcher.data]);

  // Close on successful save
  useEffect(() => {
    if (saveFetcher.data?.success) {
      onOpenChange(false);
    }
  }, [saveFetcher.data]);

  const isDirty = useMemo(() => {
    return JSON.stringify(overrides) !== JSON.stringify(initialOverrides);
  }, [overrides, initialOverrides]);

  const setFlagValue = useCallback((key: string, value: unknown) => {
    setOverrides((prev) => ({ ...prev, [key]: value }));
  }, []);

  const unsetFlag = useCallback((key: string) => {
    setOverrides((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  const handleSave = useCallback(() => {
    if (!orgId) return;

    const body = Object.keys(overrides).length === 0 ? null : overrides;

    saveFetcher.submit(JSON.stringify(body), {
      method: "POST",
      action: `/admin/api/orgs/${orgId}/feature-flags`,
      encType: "application/json",
    });
  }, [orgId, overrides, saveFetcher]);

  const data = loadFetcher.data;
  const isLoading = loadFetcher.state === "loading";
  const isSaving = saveFetcher.state === "submitting";

  // Build JSON preview
  const jsonPreview = useMemo(() => {
    if (Object.keys(overrides).length === 0) return "null";
    return JSON.stringify(overrides, null, 2);
  }, [overrides]);

  // Sort flag keys alphabetically
  const sortedFlagKeys = useMemo(() => {
    if (!data) return [];
    return Object.keys(data.controlTypes).sort();
  }, [data]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Feature Flags - {orgTitle}</DialogTitle>
          <DialogDescription>
            Org-level overrides. Unset flags inherit from global defaults.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] overflow-y-auto">
          {isLoading ? (
            <div className="py-8 text-center text-sm text-text-dimmed">Loading flags...</div>
          ) : data ? (
            <div className="flex flex-col gap-1.5">
              {sortedFlagKeys.map((key) => {
                const control = data.controlTypes[key];
                const isOverridden = key in overrides;
                const globalValue = data.globalFlags[key as keyof typeof data.globalFlags];
                const globalDisplay =
                  globalValue !== undefined ? String(globalValue) : "unset";

                return (
                  <div
                    key={key}
                    className={cn(
                      "flex items-center justify-between rounded-md px-3 py-2.5",
                      isOverridden
                        ? "border border-indigo-500/20 bg-indigo-500/5"
                        : "bg-charcoal-750"
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
                      {isOverridden && (
                        <Button variant="minimal/small" onClick={() => unsetFlag(key)}>
                          unset
                        </Button>
                      )}

                      {control.type === "boolean" && (
                        <BooleanControl
                          value={isOverridden ? (overrides[key] as boolean) : undefined}
                          onChange={(val) => setFlagValue(key, val)}
                          dimmed={!isOverridden}
                        />
                      )}

                      {control.type === "enum" && (
                        <EnumControl
                          value={isOverridden ? (overrides[key] as string) : undefined}
                          options={control.options}
                          onChange={(val) => {
                            if (val === "__unset__") {
                              unsetFlag(key);
                            } else {
                              setFlagValue(key, val);
                            }
                          }}
                          dimmed={!isOverridden}
                        />
                      )}

                      {control.type === "string" && (
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
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>

        {/* JSON Preview */}
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

        <DialogFooter>
          <Button variant="tertiary/small" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary/small"
            onClick={handleSave}
            disabled={!isDirty || isSaving}
          >
            {isSaving ? "Saving..." : "Save Changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// --- Sub-components ---

function BooleanControl({
  value,
  onChange,
  dimmed,
}: {
  value: boolean | undefined;
  onChange: (val: boolean) => void;
  dimmed: boolean;
}) {
  return (
    <Switch
      variant="small"
      checked={value ?? false}
      onCheckedChange={onChange}
      className={cn(dimmed && "opacity-50")}
    />
  );
}

function EnumControl({
  value,
  options,
  onChange,
  dimmed,
}: {
  value: string | undefined;
  options: string[];
  onChange: (val: string) => void;
  dimmed: boolean;
}) {
  const items = ["__unset__", ...options];

  return (
    <Select
      variant="tertiary/small"
      value={value ?? "__unset__"}
      setValue={onChange}
      items={items}
      text={(val) => (val === "__unset__" ? "unset" : val)}
      className={cn(dimmed && "opacity-50")}
    >
      {(items) =>
        items.map((item) => (
          <SelectItem key={item} value={item}>
            {item === "__unset__" ? "unset" : item}
          </SelectItem>
        ))
      }
    </Select>
  );
}

function StringControl({
  value,
  onChange,
  dimmed,
}: {
  value: string;
  onChange: (val: string) => void;
  dimmed: boolean;
}) {
  return (
    <Input
      variant="small"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder="unset"
      className={cn("w-40", dimmed && "opacity-50")}
    />
  );
}

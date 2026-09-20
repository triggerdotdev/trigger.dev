import { type ActionFunctionArgs, type SerializeFrom, json } from "@remix-run/server-runtime";
import { useFetcher } from "@remix-run/react";
import { useEffect, useRef, useState } from "react";
import { Cog6ToothIcon, TrashIcon } from "@heroicons/react/20/solid";
import { prisma } from "~/db.server";
import { requireUserId } from "~/services/session.server";
import { rbac } from "~/services/rbac.server";
import {
  previewAutoArchiveCount,
  savePreviewAutoArchivePolicy,
  isPreviewAutoArchiveEnabled,
} from "~/services/previewAutoArchive.server";
import { PreviewAutoArchivePolicy } from "~/utils/previewAutoArchive";
import { Button } from "~/components/primitives/Buttons";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "~/components/primitives/Dialog";
import { Input } from "~/components/primitives/Input";
import { Checkbox } from "~/components/primitives/Checkbox";
import { Fieldset } from "~/components/primitives/Fieldset";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Hint } from "~/components/primitives/Hint";
import { Label, labelVariants } from "~/components/primitives/Label";
import { Paragraph } from "~/components/primitives/Paragraph";
import { FormError } from "~/components/primitives/FormError";
import { Switch } from "~/components/primitives/Switch";
import { readBoundedBodyText } from "~/utils/boundedRequestBody.server";

import { trail } from "agentcrumbs"; // @crumbs
const crumb = trail("webapp"); // @crumbs

export async function action({ request }: ActionFunctionArgs) {
  const userId = await requireUserId(request);
  if (request.headers.get("content-type")?.split(";")[0] !== "application/x-www-form-urlencoded") {
    return json({ ok: false, error: "Unsupported form encoding." } as const, { status: 415 });
  }
  const body = await readBoundedBodyText(request, 256 * 1024);
  if (!body.ok)
    return json({ ok: false, error: "Settings are too large." } as const, { status: 413 });
  const form = new URLSearchParams(body.text);
  const environmentId = form.get("environmentId");
  const intent = form.get("intent");
  if (typeof environmentId !== "string" || (intent !== "preview" && intent !== "save")) {
    return json({ ok: false, error: "Invalid request" } as const, { status: 400 });
  }
  const policy = PreviewAutoArchivePolicy.safeParse({
    days: form.get("enabled") === "on" ? Number(form.get("days")) : null,
    excludedBranches: String(form.get("excludedBranches") ?? "")
      .split("\n")
      .map((name) => name.trim())
      .filter(Boolean),
  });
  if (!policy.success) {
    return json(
      {
        ok: false,
        error: "Enter 1–365 days and up to 100 valid branch names.",
      } as const,
      { status: 400 }
    );
  }
  const parent = await prisma.runtimeEnvironment.findFirst({
    where: {
      id: environmentId,
      type: "PREVIEW",
      parentEnvironmentId: null,
      isBranchableEnvironment: true,
      archivedAt: null,
      organization: { members: { some: { userId } } },
      project: { deletedAt: null },
    },
    select: {
      id: true,
      organizationId: true,
      projectId: true,
      organization: { select: { featureFlags: true } },
    },
  });
  if (!parent)
    return json({ ok: false, error: "Preview environment not found" } as const, { status: 404 });
  if (!(await isPreviewAutoArchiveEnabled(prisma, parent.organization.featureFlags))) {
    return json(
      { ok: false, error: "Preview auto-archive is not enabled for this organization." } as const,
      { status: 403 }
    );
  }
  const auth = await rbac.authenticateSession(request, {
    userId,
    organizationId: parent.organizationId,
    projectId: parent.projectId,
  });
  if (
    !auth.ok ||
    !(
      auth.ability.can("write", { type: "branches", envType: "PREVIEW" }) ||
      auth.ability.can("write", { type: "deployments", envType: "PREVIEW" })
    )
  ) {
    return json(
      { ok: false, error: "You don't have permission to manage preview branches." } as const,
      { status: 403 }
    );
  }
  const { days, excludedBranches } = policy.data;
  let preview = {
    count: 0,
    scheduled: 0,
    inProgress: 0,
    protectedBranches: [] as string[],
    partial: false,
  };
  if (intent === "save") {
    await savePreviewAutoArchivePolicy(prisma, parent.id, policy.data);
  } else if (days !== null) {
    try {
      preview = await previewAutoArchiveCount(prisma, parent.id, days, excludedBranches);
    } catch {
      return json(
        {
          ok: false,
          error: "Unable to preview affected branches right now. Please try again.",
        } as const,
        { status: 503 }
      );
    }
  }

  return json({
    ok: true,
    saved: intent === "save",
    ...preview,
    policyKey: JSON.stringify(policy.data),
  } as const);
}

export function AutoArchiveSettings({
  environment,
  canManage,
}: {
  environment: {
    id: string;
    previewAutoArchiveAfterDays: number | null;
    previewAutoArchiveExcludedBranches: string[];
  };
  canManage: boolean;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const enabled = environment.previewAutoArchiveAfterDays !== null;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {enabled ? (
        <DialogTrigger asChild>
          <Button
            ref={triggerRef}
            variant="secondary/small"
            LeadingIcon={Cog6ToothIcon}
            className="shrink-0 whitespace-nowrap"
            disabled={!canManage}
          >
            Manage auto-archive
          </Button>
        </DialogTrigger>
      ) : (
        <Switch
          ref={triggerRef}
          label="Auto-archive"
          variant="secondary/small"
          checked={false}
          onCheckedChange={() => setOpen(true)}
          disabled={!canManage}
        />
      )}
      <DialogContent
        className="max-h-[90vh] overflow-y-auto"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          triggerRef.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Auto-archive preview branches</DialogTitle>
        </DialogHeader>
        {open && <AutoArchiveForm environment={environment} onSaved={() => setOpen(false)} />}
      </DialogContent>
    </Dialog>
  );
}

function AutoArchiveForm({
  environment,
  onSaved,
}: {
  environment: {
    id: string;
    previewAutoArchiveAfterDays: number | null;
    previewAutoArchiveExcludedBranches: string[];
  };
  onSaved: () => void;
}) {
  const fetcher = useFetcher<typeof action>();
  const [preview, setPreview] = useState<{
    data?: SerializeFrom<typeof action> | { ok: false; error: string };
    pending: boolean;
  }>({ pending: false });
  const [requestedKey, setRequestedKey] = useState<string | null>(null);
  const [days, setDays] = useState(String(environment.previewAutoArchiveAfterDays ?? 14));
  const [keepSpecificBranches, setKeepSpecificBranches] = useState(
    environment.previewAutoArchiveExcludedBranches.length > 0
  );
  const [excludedRows, setExcludedRows] = useState(() =>
    [...environment.previewAutoArchiveExcludedBranches, ""].map((name, id) => ({ id, name }))
  );
  const nextRowId = useRef(excludedRows.length);
  const excluded = keepSpecificBranches ? excludedRows.map(({ name }) => name).join("\n") : "";
  const enabled = environment.previewAutoArchiveAfterDays !== null;

  function updateExcludedBranch(id: number, name: string) {
    const rows = excludedRows.map((row) => (row.id === id ? { ...row, name } : row));
    if (rows.every((row) => row.name.trim() !== "") && rows.length < 100) {
      rows.push({ id: nextRowId.current++, name: "" });
    }
    setExcludedRows(rows);
  }

  function removeExcludedBranch(id: number) {
    const rows = excludedRows.filter((row) => row.id !== id);
    if (rows.length === 0 || rows.every((row) => row.name.trim() !== "")) {
      rows.push({ id: nextRowId.current++, name: "" });
    }
    setExcludedRows(rows);
  }

  function disableAutoArchive() {
    crumb("disable preview auto-archive", { environmentId: environment.id }); // @crumbs
    fetcher.submit(
      {
        environmentId: environment.id,
        intent: "save",
        excludedBranches: environment.previewAutoArchiveExcludedBranches.join("\n"),
      },
      { method: "post", action: "/resources/branches/auto-archive" }
    );
  }
  const policyKey = JSON.stringify({
    days: Number(days),
    excludedBranches: [
      ...new Set(
        excluded
          .split("\n")
          .map((name) => name.trim())
          .filter(Boolean)
      ),
    ],
  });
  const valid = PreviewAutoArchivePolicy.safeParse(JSON.parse(policyKey)).success;
  const reviewed =
    valid && !preview.pending && preview.data?.ok && preview.data.policyKey === policyKey;
  const busy = fetcher.state !== "idle";
  useEffect(() => {
    if (!valid || busy) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      const policy = JSON.parse(policyKey) as { days: number; excludedBranches: string[] };
      setRequestedKey(policyKey);
      setPreview({ pending: true });
      try {
        // A read-only POST avoids URL-size limits for exclusions and Remix's
        // page-wide action revalidation while the user edits the form.
        const response = await fetch("/resources/branches/auto-archive", {
          method: "POST",
          signal: controller.signal,
          body: new URLSearchParams({
            environmentId: environment.id,
            enabled: "on",
            intent: "preview",
            days: String(policy.days),
            excludedBranches: policy.excludedBranches.join("\n"),
          }),
        });
        const data = (await response.json()) as SerializeFrom<typeof action>;
        if (!controller.signal.aborted) setPreview({ data, pending: false });
      } catch {
        if (!controller.signal.aborted) {
          setPreview({
            pending: false,
            data: { ok: false, error: "Unable to preview branches. Edit a field to try again." },
          });
        }
      }
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [policyKey, valid, busy, environment.id]);
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok && fetcher.data.saved) onSaved();
  }, [fetcher.state, fetcher.data, onSaved]);

  return (
    <fetcher.Form
      method="post"
      action="/resources/branches/auto-archive"
      className="mt-4 flex flex-col gap-4"
    >
      <input type="hidden" name="environmentId" value={environment.id} />
      <input type="hidden" name="enabled" value="on" />
      <input type="hidden" name="excludedBranches" value={excluded} />
      <Fieldset>
        <InputGroup fullWidth>
          <Label htmlFor="archive-days">Automatically archive preview branches after</Label>
          <Input
            id="archive-days"
            name="days"
            type="number"
            min={1}
            max={365}
            required
            disabled={busy}
            value={days}
            onChange={(event) => setDays(event.target.value)}
            className="min-w-0"
            accessory={<span className="text-sm text-text-bright">days</span>}
            aria-describedby="archive-days-description"
          />
          <div id="archive-days-description">
            <Hint>Since the last deployment, or branch creation if never deployed.</Hint>
          </div>
        </InputGroup>
        <InputGroup fullWidth>
          <div className="flex items-center gap-2">
            <Checkbox
              id="keep-specific-branches"
              checked={keepSpecificBranches}
              disabled={busy}
              onChange={(event) => setKeepSpecificBranches(event.target.checked)}
              aria-controls="archive-exclusions"
            />
            <Label htmlFor="keep-specific-branches" className="cursor-pointer">
              Keep specific branches
            </Label>
          </div>
          {keepSpecificBranches && (
            <div id="archive-exclusions" className="grid gap-1.5 pl-6">
              {excludedRows.map((row, index) => (
                <div key={row.id} className="flex items-center gap-2">
                  <Input
                    id={`archive-exclusion-${row.id}`}
                    aria-label={`Branch to keep ${index + 1}`}
                    aria-describedby="archive-exclusions-description"
                    maxLength={255}
                    placeholder={index === 0 ? "Branch name, e.g. staging" : "Add another branch"}
                    disabled={busy}
                    value={row.name}
                    onChange={(event) => updateExcludedBranch(row.id, event.target.value)}
                  />
                  {(row.name !== "" || index < excludedRows.length - 1) && (
                    <Button
                      type="button"
                      variant="secondary/medium"
                      LeadingIcon={TrashIcon}
                      aria-label={`Remove branch ${row.name || index + 1}`}
                      disabled={busy}
                      onClick={() => removeExcludedBranch(row.id)}
                    />
                  )}
                </div>
              ))}
              <div id="archive-exclusions-description">
                <Hint>
                  Never auto-archive these branches. Enter one exact branch name per field; no
                  wildcards.
                </Hint>
              </div>
            </div>
          )}
        </InputGroup>
        <section
          className="max-h-48 overflow-y-auto"
          aria-labelledby="archive-preview-title"
          aria-live="polite"
          aria-busy={valid && !reviewed && preview.pending}
        >
          <h3 id="archive-preview-title" className={`${labelVariants.medium.text} mb-2`}>
            Preview
          </h3>
          {!valid ? (
            <Paragraph>Enter 1–365 days and valid branch names to see the preview.</Paragraph>
          ) : reviewed && preview.data?.ok ? (
            <div className="space-y-2 text-sm text-text-dimmed">
              <ul className="list-disc space-y-1 pl-4">
                <li className={preview.data.count > 0 ? "text-amber-400" : undefined}>
                  {preview.data.partial ? "At least " : ""}
                  {preview.data.count} {preview.data.count === 1 ? "branch is" : "branches are"}{" "}
                  ready to archive now.
                  {preview.data.count > 0 &&
                    " Saving will make these branches eligible for the next cleanup check."}
                </li>
                <li>
                  {preview.data.partial ? "At least " : ""}
                  {preview.data.scheduled}{" "}
                  {preview.data.scheduled === 1 ? "branch will" : "branches will"} archive later if
                  no new deployments occur.
                </li>
                <li>
                  {preview.data.partial ? "At least " : ""}
                  {preview.data.protectedBranches.length} protected{" "}
                  {preview.data.protectedBranches.length === 1 ? "branch will" : "branches will"} be
                  ignored.
                </li>
                {preview.data.inProgress > 0 && (
                  <li>
                    {preview.data.partial ? "At least " : ""}
                    {preview.data.inProgress}{" "}
                    {preview.data.inProgress === 1 ? "branch has" : "branches have"} a deployment in
                    progress and will be skipped.
                  </li>
                )}
              </ul>
              {preview.data.protectedBranches.length > 0 && (
                <p className="break-words">
                  Protected: {preview.data.protectedBranches.join(", ")}
                </p>
              )}
              {preview.data.partial && (
                <p>Preview limited to the first 1,000 branches. Cleanup checks all branches.</p>
              )}
            </div>
          ) : requestedKey === policyKey && !preview.pending && preview.data && !preview.data.ok ? (
            <FormError>{preview.data.error}</FormError>
          ) : (
            <Paragraph>Checking branches…</Paragraph>
          )}
        </section>
      </Fieldset>
      {fetcher.data && !fetcher.data.ok && <FormError>{fetcher.data.error}</FormError>}
      <DialogFooter>
        {enabled ? (
          <Button
            type="button"
            variant="secondary/medium"
            disabled={busy}
            onClick={disableAutoArchive}
          >
            Disable auto-archiving
          </Button>
        ) : (
          <Button type="button" variant="secondary/medium" disabled={busy} onClick={onSaved}>
            Cancel
          </Button>
        )}
        <Button
          type="submit"
          name="intent"
          value="save"
          variant="primary/medium"
          disabled={busy || !reviewed}
        >
          Save
        </Button>
      </DialogFooter>
    </fetcher.Form>
  );
}

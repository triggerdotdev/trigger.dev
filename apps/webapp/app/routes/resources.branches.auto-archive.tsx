import { type ActionFunctionArgs, type SerializeFrom, json } from "@remix-run/server-runtime";
import { useFetcher } from "@remix-run/react";
import { useEffect, useRef, useState } from "react";
import { Cog6ToothIcon } from "@heroicons/react/20/solid";
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
import { Dialog, DialogContent, DialogHeader, DialogTrigger } from "~/components/primitives/Dialog";
import { Input } from "~/components/primitives/Input";
import { TextArea } from "~/components/primitives/TextArea";
import { Label } from "~/components/primitives/Label";
import { Paragraph } from "~/components/primitives/Paragraph";
import { FormError } from "~/components/primitives/FormError";
import { Switch } from "~/components/primitives/Switch";
import { readBoundedBodyText } from "~/utils/boundedRequestBody.server";

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
        error: "Enter 1–365 days and up to 100 valid branch names, one per line.",
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
  const fetcher = useFetcher<typeof action>();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const enabled = environment.previewAutoArchiveAfterDays !== null;

  function handleToggle(checked: boolean) {
    if (checked) {
      setOpen(true);
    } else {
      fetcher.submit(
        {
          environmentId: environment.id,
          intent: "save",
          excludedBranches: environment.previewAutoArchiveExcludedBranches.join("\n"),
        },
        { method: "post", action: "/resources/branches/auto-archive" }
      );
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <div className="flex shrink-0 flex-col gap-1">
        <div className="flex items-center gap-1.5">
          <Switch
            ref={toggleRef}
            label="Auto-archive"
            variant="secondary/small"
            checked={enabled}
            onCheckedChange={handleToggle}
            disabled={!canManage || fetcher.state !== "idle"}
          />
          {enabled && (
            <DialogTrigger asChild>
              <Button
                variant="secondary/small"
                LeadingIcon={Cog6ToothIcon}
                aria-label="Auto-archive settings"
                className="shrink-0 whitespace-nowrap"
                disabled={!canManage || fetcher.state !== "idle"}
              >
                Settings
              </Button>
            </DialogTrigger>
          )}
        </div>
        {fetcher.data && !fetcher.data.ok && <FormError>{fetcher.data.error}</FormError>}
      </div>
      <DialogContent
        className="max-h-[90vh] overflow-y-auto"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          toggleRef.current?.focus();
        }}
      >
        <DialogHeader>Auto-archive preview branches</DialogHeader>
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
  const [excluded, setExcluded] = useState(
    environment.previewAutoArchiveExcludedBranches.join("\n")
  );
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
      <div className="flex flex-col gap-2">
        <Label htmlFor="archive-days">Days without a deployment</Label>
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
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="archive-exclusions">Protected branches</Label>
        <TextArea
          id="archive-exclusions"
          name="excludedBranches"
          rows={3}
          maxLength={25_600}
          placeholder="staging"
          disabled={busy}
          value={excluded}
          onChange={(event) => setExcluded(event.target.value)}
        />
        <Paragraph>Exact branch names, one per line.</Paragraph>
      </div>
      <section
        className="min-h-36 max-h-48 overflow-y-auto rounded border border-grid-bright p-3"
        aria-label="Archive preview"
        aria-live="polite"
        aria-busy={valid && !reviewed && preview.pending}
      >
        <Paragraph className="mb-2 text-text-bright">Preview</Paragraph>
        {!valid ? (
          <Paragraph>Enter 1–365 days and valid branch names to see the preview.</Paragraph>
        ) : reviewed && preview.data?.ok ? (
          <div className="space-y-2 text-sm text-text-dimmed">
            <ul className="list-disc space-y-1 pl-4">
              <li className={preview.data.count > 0 ? "text-amber-400" : undefined}>
                {preview.data.partial ? "At least " : ""}
                {preview.data.count} {preview.data.count === 1 ? "branch is" : "branches are"} ready
                to archive now.
                {preview.data.count > 0 &&
                  " Saving will make these branches eligible for the next cleanup check."}
              </li>
              <li>
                {preview.data.partial ? "At least " : ""}
                {preview.data.scheduled}{" "}
                {preview.data.scheduled === 1 ? "branch will" : "branches will"} archive later if no
                new deployments occur.
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
              <p className="break-words">Protected: {preview.data.protectedBranches.join(", ")}</p>
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
      {fetcher.data && !fetcher.data.ok && <FormError>{fetcher.data.error}</FormError>}
      <div className="flex justify-end gap-2">
        <Button
          type="submit"
          name="intent"
          value="save"
          variant="primary/medium"
          disabled={busy || !reviewed}
        >
          Save settings
        </Button>
      </div>
    </fetcher.Form>
  );
}

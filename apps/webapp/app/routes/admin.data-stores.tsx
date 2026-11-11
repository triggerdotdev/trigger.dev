import { withAdminAudit } from "~/services/adminAudit/adminAudit.server";
import { useId, useState } from "react";
import { useFetcher } from "@remix-run/react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/server-runtime";
import { redirect } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { noteAdminRequest } from "~/services/adminAudit/adminAuditContext.server";
import { Button } from "~/components/primitives/Buttons";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/primitives/Dialog";
import { Input } from "~/components/primitives/Input";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/primitives/Popover";
import {
  Table,
  TableBlankRow,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { requireUser } from "~/services/session.server";
import { ClickhouseConnectionSchema } from "~/services/clickhouse/clickhouseSecretSchemas.server";
import { organizationDataStoresRegistry } from "~/services/dataStores/organizationDataStoresRegistryInstance.server";
import { tryCatch } from "@trigger.dev/core/utils";

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const user = await requireUser(request);
  if (!user.admin || !env.ADMIN_DASHBOARD_ENABLED) throw redirect("/");

  const dataStores = await prisma.organizationDataStore.findMany({
    orderBy: { createdAt: "desc" },
  });

  return typedjson({ dataStores });
};

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

const OptionalUrl = z
  .string()
  .trim()
  .optional()
  .transform((value) => value || undefined)
  .pipe(z.string().url().optional());

function sameHost(connectionUrl: string, mirrorUrl: string | undefined): boolean {
  return mirrorUrl !== undefined && new URL(connectionUrl).host === new URL(mirrorUrl).host;
}

const AddSchema = z.object({
  _action: z.literal("add"),
  key: z.string().min(1),
  organizationIds: z.string().min(1),
  connectionUrl: z.string().url(),
  mirrorUrl: OptionalUrl,
});

const UpdateSchema = z.object({
  _action: z.literal("update"),
  key: z.string().min(1),
  organizationIds: z.string().min(1),
  connectionUrl: OptionalUrl,
  mirrorUrl: OptionalUrl,
});

const DeleteSchema = z.object({
  _action: z.literal("delete"),
  key: z.string().min(1),
});

const FormSchema = z.discriminatedUnion("_action", [AddSchema, UpdateSchema, DeleteSchema]);

async function handleAction({ request }: ActionFunctionArgs) {
  const user = await requireUser(request);
  if (!user.admin || !env.ADMIN_DASHBOARD_ENABLED) throw redirect("/");

  noteAdminRequest(request, { captureBody: true });

  const formData = await request.formData();

  const result = FormSchema.safeParse(Object.fromEntries(formData));

  if (!result.success) {
    return typedjson(
      { error: result.error.issues.map((i) => i.message).join(", ") },
      { status: 400 }
    );
  }

  switch (result.data._action) {
    case "add": {
      const { key, organizationIds: rawOrgIds, connectionUrl, mirrorUrl } = result.data;
      const organizationIds = rawOrgIds
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      if (sameHost(connectionUrl, mirrorUrl)) {
        return typedjson(
          { error: "Mirror connection URL must point at a different host" },
          { status: 400 }
        );
      }

      const parsedConfig = ClickhouseConnectionSchema.safeParse({ url: connectionUrl, mirrorUrl });
      if (!parsedConfig.success) {
        return typedjson(
          { error: parsedConfig.error.issues.map((i) => i.message).join(", ") },
          { status: 400 }
        );
      }

      const [error, _] = await tryCatch(
        organizationDataStoresRegistry.addDataStore({
          key,
          kind: "CLICKHOUSE",
          organizationIds,
          config: parsedConfig.data,
        })
      );

      if (error) {
        return typedjson({ error: error.message }, { status: 400 });
      }

      return typedjson({ success: true });
    }
    case "update": {
      const { key, organizationIds: rawOrgIds, connectionUrl, mirrorUrl } = result.data;
      const organizationIds = rawOrgIds
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      if (mirrorUrl && !connectionUrl) {
        return typedjson(
          { error: "Enter the ClickHouse connection URL as well to set a mirror" },
          { status: 400 }
        );
      }

      if (connectionUrl && sameHost(connectionUrl, mirrorUrl)) {
        return typedjson(
          { error: "Mirror connection URL must point at a different host" },
          { status: 400 }
        );
      }

      let config: ReturnType<typeof ClickhouseConnectionSchema.parse> | undefined;
      if (connectionUrl) {
        const parsedConfig = ClickhouseConnectionSchema.safeParse({
          url: connectionUrl,
          mirrorUrl,
        });
        if (!parsedConfig.success) {
          return typedjson(
            { error: parsedConfig.error.issues.map((i) => i.message).join(", ") },
            { status: 400 }
          );
        }
        config = parsedConfig.data;
      }

      const [error, _] = await tryCatch(
        organizationDataStoresRegistry.updateDataStore({
          key,
          kind: "CLICKHOUSE",
          organizationIds,
          config,
        })
      );

      if (error) {
        return typedjson({ error: error.message }, { status: 400 });
      }

      return typedjson({ success: true });
    }
    case "delete": {
      const { key } = result.data;

      const [error, _] = await tryCatch(
        organizationDataStoresRegistry.deleteDataStore({
          key,
          kind: "CLICKHOUSE",
        })
      );

      if (error) {
        return typedjson({ error: error.message }, { status: 400 });
      }

      return typedjson({ success: true });
    }
    default: {
      return typedjson({ error: "Unknown action" }, { status: 400 });
    }
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function AdminDataStoresRoute() {
  const { dataStores } = useTypedLoaderData<typeof loader>();
  const [addOpen, setAddOpen] = useState(false);

  return (
    <main className="flex h-full min-w-0 flex-1 flex-col overflow-y-auto px-4 pb-4">
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <Paragraph variant="small" className="text-text-dimmed">
            {dataStores.length} data store{dataStores.length !== 1 ? "s" : ""}
          </Paragraph>
          <Button variant="primary/small" onClick={() => setAddOpen(true)}>
            Add data store
          </Button>
        </div>

        <Table>
          <TableHeader>
            <TableRow>
              <TableHeaderCell>Key</TableHeaderCell>
              <TableHeaderCell>Kind</TableHeaderCell>
              <TableHeaderCell>Organizations</TableHeaderCell>
              <TableHeaderCell>Created</TableHeaderCell>
              <TableHeaderCell>Updated</TableHeaderCell>
              <TableHeaderCell>
                <span className="sr-only">Actions</span>
              </TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {dataStores.length === 0 ? (
              <TableBlankRow colSpan={6}>
                <Paragraph>No data stores configured</Paragraph>
              </TableBlankRow>
            ) : (
              dataStores.map((ds) => (
                <TableRow key={ds.id}>
                  <TableCell>
                    <span className="font-mono text-xs text-text-bright">{ds.key}</span>
                  </TableCell>
                  <TableCell>
                    <span className="inline-flex rounded-sm bg-indigo-500/20 px-1.5 py-0.5 text-[11px] font-medium text-indigo-400">
                      {ds.kind}
                    </span>
                  </TableCell>
                  <TableCell>
                    <span className="text-xs text-text-dimmed">
                      {ds.organizationIds.length} org{ds.organizationIds.length !== 1 ? "s" : ""}
                    </span>
                    {ds.organizationIds.length > 0 && (
                      <span
                        className="ml-1 text-xs text-text-dimmed"
                        title={ds.organizationIds.join(", ")}
                      >
                        ({ds.organizationIds.slice(0, 2).join(", ")}
                        {ds.organizationIds.length > 2
                          ? ` +${ds.organizationIds.length - 2} more`
                          : ""}
                        )
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    <span className="text-xs text-text-dimmed">
                      {new Date(ds.createdAt).toLocaleString()}
                    </span>
                  </TableCell>
                  <TableCell>
                    <span className="text-xs text-text-dimmed">
                      {new Date(ds.updatedAt).toLocaleString()}
                    </span>
                  </TableCell>
                  <TableCell isSticky>
                    <div className="flex items-center gap-1">
                      <EditButton name={ds.key} organizationIds={ds.organizationIds} />
                      <DeleteButton name={ds.key} />
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <AddDataStoreDialog open={addOpen} onOpenChange={setAddOpen} />
    </main>
  );
}

// ---------------------------------------------------------------------------
// Delete button with popover confirmation
// ---------------------------------------------------------------------------

function DeleteButton({ name }: { name: string }) {
  const [open, setOpen] = useState(false);
  const fetcher = useFetcher<{ success?: boolean; error?: string }>();
  const isDeleting = fetcher.state !== "idle";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="danger/small" disabled={isDeleting}>
          {isDeleting ? "Deleting…" : "Delete"}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 space-y-3">
        <Paragraph variant="small" className="text-text-bright">
          Delete <span className="font-mono font-medium">{name}</span>?
        </Paragraph>
        <Paragraph variant="extra-small" className="text-text-dimmed">
          This will remove the data store and its secret. Organizations using it will fall back to
          the default ClickHouse instance.
        </Paragraph>
        <div className="flex items-center justify-end gap-2">
          <Button variant="tertiary/small" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <fetcher.Form method="post" onSubmit={() => setOpen(false)}>
            <input type="hidden" name="_action" value="delete" />
            <input type="hidden" name="key" value={name} />
            <Button type="submit" variant="danger/small">
              Confirm delete
            </Button>
          </fetcher.Form>
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ---------------------------------------------------------------------------
// Edit button with dialog
// ---------------------------------------------------------------------------

function EditButton({ name, organizationIds }: { name: string; organizationIds: string[] }) {
  const [open, setOpen] = useState(false);
  const fieldId = useId();
  const fetcher = useFetcher<{ success?: boolean; error?: string }>();
  const isSubmitting = fetcher.state !== "idle";

  if (fetcher.data?.success && open) {
    setOpen(false);
  }

  return (
    <>
      <Button variant="secondary/small" onClick={() => setOpen(true)}>
        Edit
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit data store</DialogTitle>
          </DialogHeader>

          <fetcher.Form method="post" className="space-y-4 pt-2">
            <input type="hidden" name="_action" value="update" />
            <input type="hidden" name="key" value={name} />

            <div className="space-y-1.5">
              <label htmlFor={`${fieldId}-key`} className="text-xs font-medium text-text-dimmed">
                Key
              </label>
              <Input
                id={`${fieldId}-key`}
                name="_key_display"
                value={name}
                readOnly
                variant="medium"
                className="font-mono opacity-60"
              />
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor={`${fieldId}-organizationIds`}
                className="text-xs font-medium text-text-dimmed"
              >
                Organization IDs <span className="text-rose-400">*</span>
              </label>
              <Input
                id={`${fieldId}-organizationIds`}
                name="organizationIds"
                defaultValue={organizationIds.join(", ")}
                placeholder="clxxxxx, clyyyyy, clzzzzz"
                variant="medium"
                required
              />
              <p className="text-[11px] text-text-dimmed">Comma-separated organization IDs.</p>
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor={`${fieldId}-connectionUrl`}
                className="text-xs font-medium text-text-dimmed"
              >
                ClickHouse connection URL
              </label>
              <Input
                id={`${fieldId}-connectionUrl`}
                name="connectionUrl"
                type="password"
                placeholder="https://user:password@host:8443"
                variant="medium"
                className="font-mono"
              />
              <p className="text-[11px] text-text-dimmed">
                Leave blank to keep the stored connection. Entering it replaces the stored
                connection and mirror.
              </p>
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor={`${fieldId}-mirrorUrl`}
                className="text-xs font-medium text-text-dimmed"
              >
                Mirror connection URL
              </label>
              <Input
                id={`${fieldId}-mirrorUrl`}
                name="mirrorUrl"
                type="password"
                placeholder="https://user:password@new-host:8443"
                variant="medium"
                className="font-mono"
              />
              <p className="text-[11px] text-text-dimmed">
                Writes also go to this ClickHouse service; reads stay on the connection URL.
                Requires the connection URL above. To clear the mirror, re-enter the connection URL
                and leave this blank.
              </p>
            </div>

            {fetcher.data?.error && <p className="text-xs text-rose-400">{fetcher.data.error}</p>}

            <DialogFooter>
              <Button
                variant="tertiary/small"
                type="button"
                onClick={() => setOpen(false)}
                disabled={isSubmitting}
              >
                Cancel
              </Button>
              <Button type="submit" variant="primary/small" disabled={isSubmitting}>
                {isSubmitting ? "Saving…" : "Save"}
              </Button>
            </DialogFooter>
          </fetcher.Form>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ---------------------------------------------------------------------------
// Add data store dialog
// ---------------------------------------------------------------------------

function AddDataStoreDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const fetcher = useFetcher<{ success?: boolean; error?: string }>();
  const fieldId = useId();
  const isSubmitting = fetcher.state !== "idle";

  // Close dialog on success
  if (fetcher.data?.success && open) {
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add data store</DialogTitle>
        </DialogHeader>

        <fetcher.Form method="post" className="space-y-4 pt-2">
          <input type="hidden" name="_action" value="add" />

          <div className="space-y-1.5">
            <label htmlFor={`${fieldId}-key`} className="text-xs font-medium text-text-dimmed">
              Key <span className="text-rose-400">*</span>
            </label>
            <Input
              id={`${fieldId}-key`}
              name="key"
              placeholder="e.g. hipaa-clickhouse-us-east"
              variant="medium"
              required
              className="font-mono"
            />
            <p className="text-[11px] text-text-dimmed">
              Unique identifier for this data store. Used as the secret key prefix.
            </p>
          </div>

          <div className="space-y-1.5">
            <label htmlFor={`${fieldId}-kind`} className="text-xs font-medium text-text-dimmed">
              Kind <span className="text-rose-400">*</span>
            </label>
            <Input
              id={`${fieldId}-kind`}
              name="kind"
              value="CLICKHOUSE"
              readOnly
              variant="medium"
              className="opacity-60"
            />
          </div>

          <div className="space-y-1.5">
            <label
              htmlFor={`${fieldId}-organizationIds`}
              className="text-xs font-medium text-text-dimmed"
            >
              Organization IDs <span className="text-rose-400">*</span>
            </label>
            <Input
              id={`${fieldId}-organizationIds`}
              name="organizationIds"
              placeholder="clxxxxx, clyyyyy, clzzzzz"
              variant="medium"
              required
            />
            <p className="text-[11px] text-text-dimmed">Comma-separated organization IDs.</p>
          </div>

          <div className="space-y-1.5">
            <label
              htmlFor={`${fieldId}-connectionUrl`}
              className="text-xs font-medium text-text-dimmed"
            >
              ClickHouse connection URL <span className="text-rose-400">*</span>
            </label>
            <Input
              id={`${fieldId}-connectionUrl`}
              name="connectionUrl"
              type="password"
              placeholder="https://user:password@host:8443"
              variant="medium"
              required
              className="font-mono"
            />
            <p className="text-[11px] text-text-dimmed">
              Stored encrypted in SecretStore. Never logged or displayed again.
            </p>
          </div>

          <div className="space-y-1.5">
            <label
              htmlFor={`${fieldId}-mirrorUrl`}
              className="text-xs font-medium text-text-dimmed"
            >
              Mirror connection URL
            </label>
            <Input
              id={`${fieldId}-mirrorUrl`}
              name="mirrorUrl"
              type="password"
              placeholder="https://user:password@new-host:8443"
              variant="medium"
              className="font-mono"
            />
            <p className="text-[11px] text-text-dimmed">
              Optional. Writes also go to this ClickHouse service so the store can be moved there
              without a gap; reads stay on the connection URL.
            </p>
          </div>

          {fetcher.data?.error && <p className="text-xs text-rose-400">{fetcher.data.error}</p>}

          <DialogFooter>
            <Button
              variant="tertiary/small"
              type="button"
              onClick={() => onOpenChange(false)}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
            <Button type="submit" variant="primary/small" disabled={isSubmitting}>
              {isSubmitting ? "Adding…" : "Add data store"}
            </Button>
          </DialogFooter>
        </fetcher.Form>
      </DialogContent>
    </Dialog>
  );
}

export const action = withAdminAudit(handleAction);

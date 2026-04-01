import { useState } from "react";
import { useFetcher } from "@remix-run/react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/server-runtime";
import { redirect } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
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
import { requireUser } from "~/services/session.server";
import { getSecretStore } from "~/services/secrets/secretStore.server";
import { ClickhouseConnectionSchema } from "~/services/clickhouse/clickhouseSecretSchemas.server";

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const user = await requireUser(request);
  if (!user.admin) throw redirect("/");

  const dataStores = await prisma.organizationDataStore.findMany({
    orderBy: { createdAt: "desc" },
  });

  return typedjson({ dataStores });
};

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

const AddSchema = z.object({
  _action: z.literal("add"),
  key: z.string().min(1),
  organizationIds: z.string().min(1),
  connectionUrl: z.string().url(),
});

const DeleteSchema = z.object({
  _action: z.literal("delete"),
  id: z.string().min(1),
});

export async function action({ request }: ActionFunctionArgs) {
  const user = await requireUser(request);
  if (!user.admin) throw redirect("/");

  const formData = await request.formData();
  const _action = formData.get("_action");

  if (_action === "add") {
    const result = AddSchema.safeParse(Object.fromEntries(formData));
    if (!result.success) {
      return typedjson(
        { error: result.error.issues.map((i) => i.message).join(", ") },
        { status: 400 }
      );
    }

    const { key, organizationIds: rawOrgIds, connectionUrl } = result.data;
    const organizationIds = rawOrgIds
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const secretKey = `data-store:${key}:clickhouse`;

    const secretStore = getSecretStore("DATABASE");
    await secretStore.setSecret(secretKey, ClickhouseConnectionSchema.parse({ url: connectionUrl }));

    await prisma.organizationDataStore.create({
      data: {
        key,
        organizationIds,
        kind: "CLICKHOUSE",
        config: { version: 1, data: { secretKey } },
      },
    });


    return typedjson({ success: true });
  }

  if (_action === "delete") {
    const result = DeleteSchema.safeParse(Object.fromEntries(formData));
    if (!result.success) {
      return typedjson({ error: "Invalid request" }, { status: 400 });
    }

    const { id } = result.data;

    const dataStore = await prisma.organizationDataStore.findFirst({ where: { id } });
    if (!dataStore) {
      return typedjson({ error: "Data store not found" }, { status: 404 });
    }

    // Delete secret if config references one
    const config = dataStore.config as any;
    if (config?.data?.secretKey) {
      const secretStore = getSecretStore("DATABASE");
      await secretStore.deleteSecret(config.data.secretKey).catch(() => {
        // Secret may not exist — proceed with deletion
      });
    }

    await prisma.organizationDataStore.delete({ where: { id } });

    return typedjson({ success: true });
  }

  return typedjson({ error: "Unknown action" }, { status: 400 });
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
                    <DeleteButton id={ds.id} name={ds.key} />
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

function DeleteButton({ id, name }: { id: string; name: string }) {
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
            <input type="hidden" name="id" value={id} />
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
            <label className="text-xs font-medium text-text-dimmed">
              Key <span className="text-rose-400">*</span>
            </label>
            <Input
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
            <label className="text-xs font-medium text-text-dimmed">
              Kind <span className="text-rose-400">*</span>
            </label>
            <Input name="kind" value="CLICKHOUSE" readOnly variant="medium" className="opacity-60" />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-text-dimmed">
              Organization IDs <span className="text-rose-400">*</span>
            </label>
            <Input
              name="organizationIds"
              placeholder="clxxxxx, clyyyyy, clzzzzz"
              variant="medium"
              required
            />
            <p className="text-[11px] text-text-dimmed">Comma-separated organization IDs.</p>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-text-dimmed">
              ClickHouse connection URL <span className="text-rose-400">*</span>
            </label>
            <Input
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

          {fetcher.data?.error && (
            <p className="text-xs text-rose-400">{fetcher.data.error}</p>
          )}

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

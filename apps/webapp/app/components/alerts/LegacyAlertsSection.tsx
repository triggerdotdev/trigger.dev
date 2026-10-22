import { BellAlertIcon } from "@heroicons/react/20/solid";
import { TrashIcon } from "~/assets/icons/TrashIcon";
import { useState } from "react";
import { AgentIcon } from "~/components/dashboard-agent/agent-identity";
import { Button } from "~/components/primitives/Buttons";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
} from "~/components/primitives/Dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableCellMenu,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import { GatedMenuItem } from "./GatedMenuItem";
import {
  legacySubscriptions,
  type LegacyAlertChannelRow,
  type LegacySubscriptionRow,
} from "./legacyAlertChannels";

function deleteMenu(allowed: boolean, onDelete: () => void) {
  return (close: () => void) => (
    <div className="flex flex-col gap-1 p-1">
      <GatedMenuItem
        allowed={allowed}
        icon={TrashIcon}
        title="Delete"
        onClick={() => {
          close();
          onDelete();
        }}
      />
    </div>
  );
}

export function LegacyAlertsSection({
  channels,
  onReplace,
  onDelete,
  canWrite = true,
  canDelete = true,
  replacing = false,
  manualReplace = false,
}: {
  channels: LegacyAlertChannelRow[];
  onReplace: (row: LegacySubscriptionRow) => void;
  onDelete: (row: LegacySubscriptionRow) => void;
  canWrite?: boolean;
  canDelete?: boolean;
  replacing?: boolean;
  manualReplace?: boolean;
}) {
  const [deleting, setDeleting] = useState<LegacySubscriptionRow | undefined>();
  const rows = legacySubscriptions(channels);

  if (rows.length === 0) return null;

  return (
    <>
      <Table showTopBorder={false}>
        <TableHeader>
          <TableRow>
            <TableHeaderCell>Channel</TableHeaderCell>
            <TableHeaderCell>Alert</TableHeaderCell>
            <TableHeaderCell>Environments</TableHeaderCell>
            <TableHeaderCell hiddenLabel>Actions</TableHeaderCell>
            <TableHeaderCell hiddenLabel>Menu</TableHeaderCell>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={`${row.channelId}:${row.alertType}`}>
              <TableCell>
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="truncate text-text-bright">{row.channelName}</span>
                  <span className="truncate text-xs text-text-dimmed">{row.channelKind}</span>
                </span>
              </TableCell>
              <TableCell>{row.alertTypeLabel}</TableCell>
              <TableCell>{row.environmentNames.join(", ")}</TableCell>
              <TableCell actionClassName="py-1.5">
                {row.migration.kind === "replace" ? (
                  <Button
                    variant={manualReplace ? "secondary/small" : "ask-trigger/small"}
                    LeadingIcon={manualReplace ? BellAlertIcon : AgentIcon}
                    leadingIconClassName={manualReplace ? "text-alerts" : undefined}
                    className="whitespace-nowrap"
                    disabled={replacing || !(canWrite && (row.canWrite ?? true))}
                    onClick={() => onReplace(row)}
                  >
                    Replace with new Alert
                  </Button>
                ) : (
                  <span className="contrast-chip inline-flex items-center whitespace-nowrap rounded bg-blue-500/10 px-2 py-0.5 text-xs font-medium text-blue-400 system:text-blue-500">
                    Coming soon
                  </span>
                )}
              </TableCell>
              <TableCellMenu
                isSticky
                className="w-10 pl-2"
                popoverContent={deleteMenu(
                  canWrite && canDelete && (row.canWrite ?? true) && (row.canDelete ?? true),
                  () => setDeleting(row)
                )}
              />
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <Dialog
        open={deleting !== undefined}
        onOpenChange={(open) => !open && setDeleting(undefined)}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>Delete this legacy alert?</DialogHeader>
          <DialogDescription className="mt-3">
            {deleting ? `${deleting.alertTypeLabel} on ${deleting.channelName}` : ""}
          </DialogDescription>
          <LegacyDeleteFooter
            onCancel={() => setDeleting(undefined)}
            onConfirm={() => {
              if (deleting) onDelete(deleting);
              setDeleting(undefined);
            }}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}

export function LegacyDeleteFooter({
  onCancel,
  onConfirm,
}: {
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <DialogFooter className="gap-2 sm:justify-end">
      <Button variant="tertiary/medium" onClick={onCancel}>
        Cancel
      </Button>
      <Button variant="danger/medium" LeadingIcon={TrashIcon} onClick={onConfirm}>
        Delete
      </Button>
    </DialogFooter>
  );
}

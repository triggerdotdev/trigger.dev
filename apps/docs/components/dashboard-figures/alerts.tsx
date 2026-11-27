// The Project alerts table on the Alerts page, in Production, with the webhook row's menu open on
// Disable and Delete. The side menu is cropped off. Drawn from source (the test dashboard has no
// alerts); the webapp files it mirrors are its `sources` in lib/dashboard-figures.ts.
import {
  BellAlertIcon,
  BellSlashIcon,
  EnvelopeIcon,
  LockClosedIcon,
} from "@heroicons/react/20/solid";
import { ClipboardIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Button, EnvCombo, RowMenuItem, tableHeader, tableRow, th } from "./chrome";
import * as I from "./icons";

// app/assets/icons/TrashIcon.tsx (the menu's Delete icon; not heroicons' TrashIcon).
function TrashIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className}>
      <path
        d="M17.9355 7L17.1777 19.125C17.1117 20.179 16.2377 21 15.1816 21H8.81836C7.76231 21 6.88826 20.179 6.82227 19.125L6.06445 7H17.9355Z"
        stroke="currentColor"
        strokeWidth="2"
      />
      <rect x="4" y="6" width="16" height="2" rx="1" fill="currentColor" />
      <rect
        x="11"
        y="10"
        width="7"
        height="2"
        rx="1"
        transform="rotate(90 11 10)"
        fill="currentColor"
      />
      <rect
        x="15"
        y="10"
        width="7"
        height="2"
        rx="1"
        transform="rotate(90 15 10)"
        fill="currentColor"
      />
      <rect x="9" y="2" width="6" height="2" rx="1" fill="currentColor" />
    </svg>
  );
}

const ALERT_TYPES = "Task run failure, Deployment failure, Deployment success";

// Table.tsx, default "dimmed" variant. align-middle: a real <td> is vertically centered by default.
const td = "table-cell align-middle text-xs text-text-dimmed text-left";

/** DetailCell.tsx (small): an icon in a box, then the label over the description. */
function DetailCell({
  icon,
  label,
  description,
  className = "",
}: {
  icon: ReactNode;
  label: string;
  description: ReactNode;
  className?: string;
}) {
  return (
    <div className={`group flex h-11 w-full items-center gap-3 rounded-md p-1 pr-3 ${className}`}>
      <div className="grid h-9 w-9 place-content-center rounded-sm border border-grid-dimmed bg-background-dimmed flex-none">
        {icon}
      </div>
      <div className="flex flex-1 flex-col">
        <div className="font-sans text-sm font-medium text-text-dimmed flex-1 text-left m-0 leading-[1.1rem]">
          {label}
        </div>
        <div className="font-sans text-xs font-medium flex-1 text-left text-text-dimmed m-0">
          {description}
        </div>
      </div>
      <div className="flex flex-none items-center gap-1" />
    </div>
  );
}

// TableCellMenu is `sticky right-0` in the dashboard. Not here: in the scaled canvas it would stick
// to the shrunken viewport's edge, and nothing scrolls, so the column is at the right edge anyway.
function Menu({ open }: { open?: boolean }) {
  return (
    <div className={`${td} px-3 py-3 bg-background-dimmed`}>
      <div className="relative h-full p-1">
        <div className="absolute right-0 top-1/2 mr-1 flex -translate-y-1/2 items-center justify-end gap-0.5 rounded-[0.25rem] p-0.5 bg-background-dimmed">
          <div
            data-mark={open ? "row-menu" : undefined}
            data-mark-badge={open ? "left" : undefined}
            className={`flex items-center justify-center size-6 rounded-[3px] ${open ? "text-text-bright" : "text-text-dimmed"}`}
          >
            <I.EllipsisVerticalIcon className="size-5" />
          </div>
        </div>
        {open && (
          // PopoverContent, align="end" under the trigger (sideOffset 4).
          <div className="absolute right-1 top-[calc(50%+1rem)] z-50 rounded border border-grid-bright bg-background-bright shadow-md min-w-40 max-w-80 p-0">
            <div className="flex flex-col gap-1 p-1">
              <RowMenuItem
                markInner
                className="h-[1.8rem] px-[0.4rem] rounded-sm text-xs"
                markBadge="left"
                icon={BellSlashIcon}
                iconClassName="text-dimmed"
                mark="disable"
              >
                Disable
              </RowMenuItem>
              <RowMenuItem
                markInner
                className="h-[1.8rem] px-[0.4rem] rounded-sm text-xs"
                markBadge="left"
                icon={TrashIcon}
                iconClassName="text-rose-500"
                mark="delete"
              >
                Delete
              </RowMenuItem>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function AlertsFigure() {
  return (
    <div className="h-full bg-background-dimmed">
      <div className="flex h-fit items-end justify-between p-2 pl-3">
        <div className="font-sans text-base leading-6 font-semibold tracking-tight text-text-bright">
          Project alerts
        </div>
        <Button variant="primary" icon={I.PlusIcon} shortcut="n" mark="new-alert" markBadge="left">
          New alert
        </Button>
      </div>
      <div className="whitespace-nowrap border-t">
        <div className="table w-full">
          <div className={tableHeader}>
            <div className="table-row relative w-full">
              <div className={th}>Name</div>
              <div className={th}>Alert types</div>
              <div className={th}>Channel</div>
              <div className={th}>Enabled</div>
              <div className={th}>Environments</div>
              <div className={th} />
            </div>
          </div>
          <div className="table-row-group relative">
            <div className={tableRow}>
              <div className={`${td} px-3 py-3`}>Email to sam@example.com</div>
              <div className={`${td} px-3 py-3`}>{ALERT_TYPES}</div>
              <div className={`${td} px-3 py-1`}>
                <DetailCell
                  icon={<EnvelopeIcon className="size-5 text-text-dimmed" />}
                  label="Email"
                  description="sam@example.com"
                  className="h-12"
                />
              </div>
              <div className={`${td} px-3 py-3`}>
                <Enabled />
              </div>
              <div className={`${td} px-3 py-3`}>
                <div className="flex items-center gap-3">
                  <EnvCombo env="prod" className="text-xs" />
                </div>
              </div>
              <Menu />
            </div>
            <div className={tableRow}>
              <div className={`${td} px-3 py-3`}>Webhook to example.com</div>
              <div className={`${td} px-3 py-3`}>{ALERT_TYPES}</div>
              <div className={`${td} px-3 py-1`}>
                <DetailCell
                  icon={<I.RegionsIcon className="size-5 text-text-dimmed" />}
                  label="https://example.com/webhook"
                  description={
                    // ClipboardField secondary/small with a lock icon, masked, w-80.
                    <span className="flex items-center text-text-dimmed font-mono rounded border border-border-bright/50 shadow-xs bg-input-bg text-xs w-full mt-1 w-80">
                      <span className="flex items-center pl-1">
                        <LockClosedIcon className="size-4" />
                      </span>
                      <span className="shrink grow w-full min-w-0 bg-transparent border-0 text-xs px-2 rounded-l h-6 leading-6">
                        {"•".repeat(32)}
                      </span>
                      <span className="flex size-6 shrink-0 items-center justify-center rounded border border-border-bright bg-background-hover text-text-dimmed rounded-l-none border-l border-grid-dimmed">
                        <ClipboardIcon className="size-3.5" />
                      </span>
                    </span>
                  }
                />
              </div>
              <div className={`${td} px-3 py-3`}>
                <Enabled />
              </div>
              <div className={`${td} px-3 py-3`}>
                <div className="flex items-center gap-3">
                  <EnvCombo env="prod" className="text-xs" />
                </div>
              </div>
              <Menu open />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** EnabledStatus.tsx with the bell icons. */
function Enabled() {
  return (
    <div className="flex items-center gap-1 text-xs text-success">
      <BellAlertIcon className="size-4" />
      Enabled
    </div>
  );
}

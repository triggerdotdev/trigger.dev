// The API keys page. Copied from the rendered dashboard; the webapp files it mirrors are its
// `sources` in lib/dashboard-figures.ts.
import { AppFrame, Button, Cell, PageHeader, SideMenu, tableHeader, tableRow, th } from "./chrome";
import * as I from "./icons";

type Key = {
  name: string;
  note?: string;
  secret: string;
  access: string;
  /** ApiKeyAccessCell's task scope, after the preset name. */
  scope?: string;
  custom?: boolean;
  ips: string;
  createdBy: string;
  created: string;
  lastUsed: string;
  expiry: string;
};

const keys: Key[] = [
  {
    name: "Backend",
    note: "Next.js app on Vercel",
    secret: "tr_dev_sk_••••••••YBm2",
    access: "Trigger only",
    scope: "· All tasks",
    ips: "Any IP",
    createdBy: "Sam Lee",
    created: "17 Nov 2026, 12:22 pm",
    lastUsed: "25 Nov 2026, 9:41 am",
    expiry: "15 Feb 2027",
  },
  {
    name: "Status page",
    secret: "tr_dev_sk_••••••••cXPv",
    access: "Observer",
    ips: "203.0.113.0/24",
    createdBy: "Sam Lee",
    created: "10 Nov 2026, 3:05 pm",
    lastUsed: "Never",
    expiry: "Never",
  },
];

// align-middle: a real <td> is vertically centered by default; a display:table-cell div is not.
const td = "table-cell align-middle text-text-dimmed";
const badge =
  "grid place-items-center border border-border-bright rounded-sm px-1 h-4 text-xxs bg-background-bright whitespace-nowrap";

function Active() {
  return (
    <span className="flex items-center gap-1 text-xs">
      <I.CheckCircleIcon className="text-success size-4" />
      <span className="text-success">Active</span>
    </span>
  );
}

function Menu() {
  return (
    <div className={td}>
      <div className="relative h-full p-1">
        <div className="absolute right-0 top-1/2 mr-1 flex -translate-y-1/2 items-center justify-end gap-0.5 rounded-[0.25rem] p-0.5 bg-background-dimmed">
          <div className="flex items-center justify-center size-6 rounded-[3px] text-text-dimmed">
            <I.EllipsisVerticalIcon className="size-5" />
          </div>
        </div>
      </div>
    </div>
  );
}

export function ApiKeysFigure() {
  return (
    <AppFrame menu={<SideMenu active="API keys" open={["Security"]} />}>
      <PageHeader title="API keys">
        <Button>View history</Button>
        <Button variant="docs" icon={I.BookIcon}>
          API keys docs
        </Button>
      </PageHeader>
      <div className="flex h-fit shrink-0 flex-wrap items-center justify-end gap-2 px-2 py-2">
        <Button>How to set env vars</Button>
        <div className="flex items-center h-6 gap-x-1.5 rounded pr-1 py-[0.1rem] pl-1.5 text-text-dimmed border border-border-bright/50 shadow-xs bg-secondary">
          <span className="whitespace-nowrap text-xs text-text-bright">Show revoked</span>
          <div className="inline-flex shrink-0 items-center rounded-full border-2 border-transparent h-3 w-5.5 bg-surface-control-hover">
            <span className="h-2.5 w-2.5 block rounded-full bg-white dark:bg-charcoal-200" />
          </div>
        </div>
        <Button variant="primary" icon={I.PlusIcon} shortcut="n" mark="create" markBadge="below">
          Create API key
        </Button>
      </div>
      <div className="whitespace-nowrap border-t">
        <div className="table w-full">
          <div className={tableHeader}>
            <div className={tableRow}>
              {[
                "Name",
                "Secret key",
                "Status",
                "Access",
                "Allowed IPs",
                "Created by",
                "Created",
                "Last used",
                "Expiry",
              ].map((h) => (
                <div key={h} className={th}>
                  {h}
                </div>
              ))}
              <div className={`${th} w-32`} />
            </div>
          </div>
          <div className="table-row-group relative">
            <div className={tableRow}>
              <Cell>
                <div className="flex items-center gap-1.5">
                  Root API key
                  <div className={`${badge} text-text-dimmed`}>
                    <span>Legacy</span>
                  </div>
                </div>
              </Cell>
              <div className={`${td} text-xs align-middle px-3 py-3 text-left`}>
                <div className="flex items-center gap-1">
                  <span className="font-mono">tr_dev_••••••••SCPk</span>
                  <I.InformationCircleIcon className="size-3.5 text-text-dimmed flex-0" />
                </div>
              </div>
              <Cell>
                <Active />
              </Cell>
              <Cell>
                <div className="flex max-w-[22rem] items-center gap-1.5 text-xs">
                  <span className="truncate min-w-0">No restrictions</span>
                </div>
              </Cell>
              <Cell>
                <span className="text-xs">Any IP</span>
              </Cell>
              <Cell>–</Cell>
              <Cell>–</Cell>
              <Cell>–</Cell>
              <Cell>Never</Cell>
              <Menu />
            </div>
            {keys.map((k) => (
              <div key={k.name} className={tableRow}>
                <Cell>
                  {k.note ? (
                    <span className="flex flex-col max-w-[14rem]">
                      <span className="truncate block">{k.name}</span>
                      <span className="truncate block text-text-faint">{k.note}</span>
                    </span>
                  ) : (
                    k.name
                  )}
                </Cell>
                <Cell>
                  <span className="font-mono">{k.secret}</span>
                </Cell>
                <Cell>
                  <Active />
                </Cell>
                <Cell>
                  <div className="flex max-w-[22rem] items-center gap-1.5 text-xs">
                    <span className="truncate min-w-0">{k.access}</span>
                    {k.scope && <span className="shrink-0 whitespace-nowrap">{k.scope}</span>}
                  </div>
                </Cell>
                <Cell>
                  <span className={k.ips === "Any IP" ? "text-xs" : "text-xs font-mono"}>
                    {k.ips}
                  </span>
                </Cell>
                <Cell>
                  <span className="truncate block max-w-[10rem]">{k.createdBy}</span>
                </Cell>
                <Cell>
                  <span>{k.created}</span>
                </Cell>
                <Cell>{k.lastUsed}</Cell>
                <Cell>{k.expiry}</Cell>
                <Menu />
              </div>
            ))}
          </div>
        </div>
      </div>
    </AppFrame>
  );
}

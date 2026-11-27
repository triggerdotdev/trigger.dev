import { useLocation, useNavigation, useParams } from "@remix-run/react";
import { useEffect, useRef, useState } from "react";
import { redirect, typedjson, useTypedFetcher, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { AuditLogCredentialSummaryLoader } from "~/components/auditLogs/AuditLogCredentialSummary";
import { auditLogSummarySearch } from "~/components/auditLogs/auditLogSummarySearch";
import { AuditLogDetail } from "~/components/auditLogs/AuditLogDetail";
import { AuditLogFilterBar } from "~/components/auditLogs/AuditLogFilters";
import { AuditLogTable } from "~/components/auditLogs/AuditLogTable";
import { ListCheckedIcon } from "~/assets/icons/ListCheckedIcon";
import { Feedback } from "~/components/Feedback";
import { MainCenteredContainer, PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Callout } from "~/components/primitives/Callout";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { Header3 } from "~/components/primitives/Headers";
import { InfoPanel } from "~/components/primitives/InfoPanel";
import { Paragraph } from "~/components/primitives/Paragraph";
import {
  collapsibleHandleClassName,
  RESIZABLE_PANEL_ANIMATION,
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "~/components/primitives/Resizable";
import { $replica } from "~/db.server";
import { useCanManageBilling, useOrganization } from "~/hooks/useOrganizations";
import { useShowSelfServe } from "~/hooks/useShowSelfServe";
import {
  auditLogFilters,
  AuditLogPresenter,
  AuditLogSearchParams,
  type AuditLogEventView,
  invalidTimeParams,
} from "~/presenters/v3/AuditLogPresenter.server";
import { parseCredentialReference } from "~/presenters/v3/auditLogCredentials.server";
import { auditLogSelectedLabels } from "~/presenters/v3/auditLogMenus.server";
import {
  AUDIT_LOG_PAGE_AUTHORIZATION,
  auditLogPageContext,
} from "~/services/auditLogs/auditLogPageAccess.server";
import { auditLogsOnPlan } from "~/services/auditLogs/auditEventsApi.server";
import { auditLogs, getAuditLogController } from "~/services/auditLogs/auditLogs.server";
import { dashboardLoader } from "~/services/routeBuilders/dashboardBuilder";
import { pageMeta } from "~/utils/pageTitle";
import { v3BillingPath } from "~/utils/pathBuilder";

export const meta = pageMeta("Audit log");

const Params = z.object({ organizationSlug: z.string() });

export const loader = dashboardLoader(
  {
    params: Params,
    context: auditLogPageContext,
    authorization: AUDIT_LOG_PAGE_AUTHORIZATION,
  },
  async ({ request, context }) => {
    const organizationId = context.organizationId;
    if (!organizationId) {
      throw new Response("Not Found", { status: 404 });
    }

    // Without the audit log plugin (self-hosted) nothing is ever recorded.
    if (!(await getAuditLogController())) {
      return typedjson({ available: false as const, reason: "self_hosted" as const });
    }
    if (!(await auditLogsOnPlan(organizationId))) {
      return typedjson({ available: false as const, reason: "plan" as const });
    }

    const url = new URL(request.url);
    // A start or end that isn't a date would break the time filter: drop it, as other bad values are.
    const invalidDates = invalidTimeParams(url.searchParams);
    if (invalidDates.length > 0) {
      for (const name of invalidDates) url.searchParams.delete(name);
      return redirect(`${url.pathname}${url.search}`);
    }
    const searchParams = AuditLogSearchParams.parse(Object.fromEntries(url.searchParams));
    const presenter = new AuditLogPresenter($replica, (query) => auditLogs.listEvents(query));

    // The filter options load once per page view, from their own route.
    // What the filters show for the values picked, which a menu's first page may not include. A
    // later page only appends events.
    if (searchParams.cursor) {
      const page = await presenter.call(organizationId, searchParams);
      return typedjson({ available: true as const, page, selectedLabels: null });
    }
    // A personal access token is named only once its events show it acted here, so its label waits
    // for the events. Everything else is looked up alongside them.
    const filters = auditLogFilters(searchParams);
    if (parseCredentialReference(filters.credential)?.kind === "pat") {
      const page = await presenter.call(organizationId, searchParams);
      const selectedLabels = await auditLogSelectedLabels($replica, organizationId, {
        ...page.filters,
        patActedHere: page.patActedHere,
      });
      return typedjson({ available: true as const, page, selectedLabels });
    }
    const [page, selectedLabels] = await Promise.all([
      presenter.call(organizationId, searchParams),
      auditLogSelectedLabels($replica, organizationId, filters),
    ]);

    return typedjson({ available: true as const, page, selectedLabels });
  }
);

function AuditLogNavBar({ canExport }: { canExport: boolean }) {
  return (
    <NavBar>
      <PageTitle
        title="Audit log"
        accessory="Who changed credentials, environment variables and members in your organization, and from where."
      />
      {canExport ? (
        <PageAccessories>
          <Button variant="secondary/small" disabled tooltip="Coming later">
            Export CSV
          </Button>
        </PageAccessories>
      ) : null}
    </NavBar>
  );
}

export default function Page() {
  const data = useTypedLoaderData<typeof loader>();

  return (
    <PageContainer>
      <AuditLogNavBar canExport={data.available} />
      <PageBody scrollable={false}>
        {data.available ? (
          <AuditLog />
        ) : data.reason === "plan" ? (
          <AuditLogUpgradePanel />
        ) : (
          // As the Roles page says it for a self-hosted deployment without the plugin.
          <div className="flex flex-col items-center gap-2 p-8 text-center">
            <Header3>Audit logs aren't available in this self-hosted deployment.</Header3>
            <Paragraph variant="small" className="text-text-dimmed">
              Audit logs are available in Trigger.dev Cloud or with an enterprise self-hosted
              license.
            </Paragraph>
          </div>
        )}
      </PageBody>
    </PageContainer>
  );
}

/** As the Branches page asks a plan without preview branches to upgrade. */
function AuditLogUpgradePanel() {
  const organization = useOrganization();
  const showSelfServe = useShowSelfServe();
  // Admins can view the audit log but not billing.
  const canManageBilling = useCanManageBilling();

  return (
    <MainCenteredContainer className="max-w-md">
      <InfoPanel
        title="Upgrade to get audit logs"
        icon={ListCheckedIcon}
        panelClassName="max-w-full"
        accessory={
          !showSelfServe ? (
            <Feedback
              button={<Button variant="secondary/small">Request more</Button>}
              defaultValue="enterprise"
            />
          ) : canManageBilling ? (
            <LinkButton variant="primary/small" to={v3BillingPath(organization)}>
              Upgrade
            </LinkButton>
          ) : (
            // A Button, not a disabled LinkButton: its tooltip still shows while disabled.
            <Button
              variant="primary/small"
              disabled
              tooltip="You don't have permission to manage billing"
            >
              Upgrade
            </Button>
          )
        }
      >
        <Paragraph variant="small" spacing={showSelfServe && !canManageBilling}>
          See who changed credentials, environment variables and members in your organization, and
          from where.
        </Paragraph>
        {/* The disabled button's tooltip can't be reached by keyboard, so say it here too. */}
        {showSelfServe && !canManageBilling ? (
          <Paragraph variant="small">
            Someone who can manage billing for your organization can upgrade.
          </Paragraph>
        ) : null}
      </InfoPanel>
    </MainCenteredContainer>
  );
}

function AuditLog() {
  const data = useTypedLoaderData<typeof loader>();
  const location = useLocation();
  const fetcher = useTypedFetcher<typeof loader>();

  if (!data.available) return null;

  return (
    <AuditLogList
      page={data.page}
      search={location.search}
      selectedLabels={data.selectedLabels ?? {}}
      fetcher={fetcher}
    />
  );
}

/** The event a URL selects, when it's on the page: a shared link to another opens nothing. */
function selectedEventId(page: LoaderData["page"], search: string): string | undefined {
  const id = new URLSearchParams(search).get("event");
  return page.events.some((event) => event.id === id) ? (id ?? undefined) : undefined;
}

type LoaderData = Extract<
  ReturnType<typeof useTypedLoaderData<typeof loader>>,
  { available: true }
>;

function AuditLogList({
  page,
  search,
  selectedLabels,
  fetcher,
}: {
  page: LoaderData["page"];
  /** The search `page` is for: a new one starts a new list, without remounting the page. */
  search: string;
  selectedLabels: NonNullable<LoaderData["selectedLabels"]>;
  fetcher: ReturnType<typeof useTypedFetcher<typeof loader>>;
}) {
  const location = useLocation();
  const navigation = useNavigation();
  const { organizationSlug = "" } = useParams();
  const summarySearch = auditLogSummarySearch(new URLSearchParams(location.search));
  const [events, setEvents] = useState<AuditLogEventView[]>(page.events);
  // The next page's cursor, and why the last "Load more" failed. A failed page keeps its cursor, so
  // "Load more" can try again.
  const [more, setMore] = useState<{ nextCursor: string | null; error: string | null }>({
    nextCursor: page.nextCursor,
    error: null,
  });
  const { nextCursor, error: loadMoreError } = more;
  const error = page.error;
  // A shared link to an event that isn't on this page opens nothing: the URL drops it below.
  const [selectedId, setSelectedId] = useState(() => selectedEventId(page, search));

  // A new search starts a new list. Reset here rather than by remounting, so the filter bar and
  // its open menu stay put while the next results load.
  const [listSearch, setListSearch] = useState(search);
  if (listSearch !== search) {
    setListSearch(search);
    setEvents(page.events);
    setMore({ nextCursor: page.nextCursor, error: null });
    setSelectedId(selectedEventId(page, search));
  }

  // The search this list is waiting on a next page for: the fetcher's last data may belong to an
  // earlier search.
  const loadingMoreFor = useRef<string | null>(null);

  // A new search's results start at the top, as they did when the page remounted.
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
  }, [search]);

  useEffect(() => {
    const data = fetcher.data;
    if (loadingMoreFor.current === null || fetcher.state !== "idle" || !data?.available) return;
    const pageSearch = loadingMoreFor.current;
    loadingMoreFor.current = null;
    if (pageSearch !== search) return;
    // The fetcher is the external system here: the page it loaded arrives after the click.
    setEvents((current) => {
      const seen = new Set(current.map((event) => event.id));
      return [...current, ...data.page.events.filter((event) => !seen.has(event.id))];
    });
    // oxlint-disable-next-line react/set-state-in-effect -- Takes in the page a fetcher loaded, as above.
    setMore((current) => ({
      nextCursor: data.page.error ? current.nextCursor : data.page.nextCursor,
      error: data.page.error,
    }));
  }, [fetcher.state, fetcher.data, search]);

  const loadMore = () => {
    if (!nextCursor) return;
    const nextPage = new URLSearchParams(location.search);
    nextPage.set("cursor", nextCursor);
    nextPage.delete("event");
    loadingMoreFor.current = search;
    fetcher.load(`${location.pathname}?${nextPage.toString()}`);
  };

  // The selected event is kept in the URL without a navigation, so the list isn't reloaded.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (selectedId) url.searchParams.set("event", selectedId);
    else url.searchParams.delete("event");
    if (url.href === window.location.href) return;
    // Keeps the router's own history state.
    window.history.replaceState(window.history.state, "", url.toString());
  }, [selectedId]);

  const selected = selectedId ? events.find((event) => event.id === selectedId) : undefined;

  return (
    <div className="grid h-full grid-rows-[auto_1fr] overflow-hidden">
      <div className="border-b border-grid-bright p-2">
        <AuditLogFilterBar filters={page.filters} selectedLabels={selectedLabels} />
      </div>
      <ResizablePanelGroup orientation="horizontal" className="min-h-0">
        <ResizablePanel id="audit-log-events" min="300px">
          <div
            ref={scroller}
            className="h-full overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-surface-control"
          >
            {error ? (
              <div className="p-2">
                <Callout variant="error">{error}</Callout>
              </div>
            ) : null}
            {(page.filters.credential || page.filters.keyLast4) && !error ? (
              <AuditLogCredentialSummaryLoader
                // A new set of filters starts a new fetcher: an answer for the old ones is dropped.
                key={summarySearch}
                organizationSlug={organizationSlug}
                search={summarySearch}
                range={page.range}
              />
            ) : null}
            <AuditLogTable
              events={events}
              selectedId={selected?.id}
              onSelect={setSelectedId}
              hasMore={Boolean(nextCursor)}
              isLoadingMore={fetcher.state !== "idle"}
              loadMoreError={loadMoreError}
              onLoadMore={loadMore}
              isFiltered={location.search.replace(/[?&]event=[^&]*/, "").length > 1}
              isLoading={
                navigation.state === "loading" && navigation.location.pathname === location.pathname
              }
            />
          </div>
        </ResizablePanel>
        <ResizableHandle
          id="audit-log-detail-handle"
          className={collapsibleHandleClassName(Boolean(selected))}
        />
        <ResizablePanel
          id="audit-log-detail"
          default="420px"
          min="360px"
          max="640px"
          className="overflow-hidden"
          collapsible
          collapsed={!selected}
          onCollapseChange={() => {}}
          collapsedSize="0px"
          collapseAnimation={RESIZABLE_PANEL_ANIMATION}
        >
          <div className="h-full" style={{ minWidth: 360 }}>
            {selected ? (
              <AuditLogDetail event={selected} onClose={() => setSelectedId(undefined)} />
            ) : null}
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}

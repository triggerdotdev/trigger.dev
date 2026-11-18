import { ChartSyncProvider } from "~/components/primitives/charts/ChartSyncContext";
import { TextLink } from "~/components/primitives/TextLink";
import { AlertDetailChart } from "./AlertDetailChart";
import type { DetailWindow } from "./alertDetailWindow";
import { tileHasData, type GroupMemberTile } from "./groupMembers";

const TILE_CLASS =
  "flex min-w-0 basis-[calc((100%-1rem)/3)] grow flex-col gap-1 overflow-hidden rounded border border-grid-bright bg-background-bright py-2 pl-2 pr-3";

export function GroupMemberTilesPlaceholder({ count }: { count: number }) {
  return (
    <div className="flex flex-wrap gap-2 p-2">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className={TILE_CLASS}>
          <div className="h-56 animate-pulse rounded bg-charcoal-750" />
        </div>
      ))}
    </div>
  );
}

export function GroupMemberTiles({
  tiles,
  window,
  now,
}: {
  tiles: GroupMemberTile[];
  window: DetailWindow & {
    isLifetime?: boolean;
    explicitTo?: boolean;
  };
  now: Date;
}) {
  return (
    <ChartSyncProvider>
      <div data-testid="group-member-tiles" className="flex flex-wrap gap-2 p-2">
        {tiles.map((tile) => (
          <div key={tile.id} data-testid="member-tile" className={TILE_CLASS}>
            <AlertDetailChart
              compact
              tileTitle={tile.name}
              tileEmpty={!tileHasData(tile)}
              alert={tile.alert}
              metricSeriesMap={new Map(tile.metricSeriesEntries)}
              healthBands={tile.healthBands}
              componentSeries={tile.componentSeries}
              limitTiles={tile.limitTiles}
              window={window}
              now={now}
              createdAt={tile.createdAt}
              queryGroups={tile.queryGroups}
              querySeriesMode={tile.querySeriesMode}
            />
          </div>
        ))}
      </div>
    </ChartSyncProvider>
  );
}

export function GroupMembershipBanner({ name, to }: { name: string; to: string }) {
  return (
    <div
      data-testid="group-membership-banner"
      className="border-b border-grid-bright bg-background-bright px-3 py-1.5 text-sm text-text-dimmed"
    >
      In group <TextLink to={to}>{name}</TextLink>
    </div>
  );
}

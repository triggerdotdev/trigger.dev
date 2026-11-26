// The Tasks page in Development: the task list with its search, type filter and New task button.
// The header and side menu are copied from the rendered dashboard; the list is drawn from source
// (the test dashboard has no tasks). The webapp files it mirrors are its `sources` in
// lib/dashboard-figures.ts.
import {
  AppFrame,
  Button,
  Cell,
  PageHeader,
  ShortcutKey,
  SideMenu,
  tableHeader,
  tableRow,
  td,
  th,
} from "./chrome";
import { Segment } from "./form-parts";
import * as I from "./icons";
import { ActivitySparkline, TaskKindIcon, type TaskKind } from "./task-parts";

type Task = {
  slug: string;
  kind: TaskKind;
  file: string;
  ok?: number[];
  failed?: number[];
  mark?: boolean;
};

// 24 hourly buckets, oldest first.
const quiet = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
const at = (counts: Record<number, number>) => quiet.map((_, i) => counts[i] ?? 0);

const tasks: Task[] = [
  { slug: "child-task", kind: "STANDARD", file: "src/trigger/simple.ts", ok: at({ 18: 2, 22: 4 }) },
  {
    slug: "create-embedding-for-post",
    kind: "STANDARD",
    file: "src/trigger/tasks/create-embedding-for-post.ts",
  },
  { slug: "first-scheduled-task", kind: "SCHEDULED", file: "src/trigger/scheduled.ts", mark: true },
  {
    slug: "hello-world",
    kind: "STANDARD",
    file: "src/trigger/example.ts",
    ok: at({ 9: 3, 10: 5, 14: 2, 18: 6, 21: 4, 22: 9 }),
    failed: at({ 10: 1, 22: 1 }),
  },
  {
    slug: "parent-task",
    kind: "STANDARD",
    file: "src/trigger/simple.ts",
    ok: at({ 18: 1, 22: 2 }),
  },
];

// SegmentedControl, secondary/small. The kinds are icon-only segments.
const segments: { kind?: TaskKind; mark?: string }[] = [
  {},
  { kind: "AGENT" },
  { kind: "STANDARD" },
  { kind: "SCHEDULED", mark: "scheduled-filter" },
  { kind: "WEBHOOK" },
];

function Toolbar() {
  return (
    <div className="flex shrink-0 items-center justify-between gap-1.5 p-2">
      <div className="flex flex-1 items-center gap-1.5">
        <div className="flex items-center gap-1">
          <div className="relative h-6 min-w-52">
            <div className="flex items-center px-1 h-6 rounded border border-border-bright/50 shadow-xs bg-input-bg w-full">
              <div className="flex items-center">
                <I.SearchIcon className="size-4 text-text-bright" />
              </div>
              <div className="grow h-full w-full px-1 rounded text-xs leading-6 text-text-dimmed">
                Search tasks…
              </div>
              <div className="pr-0.5">
                <ShortcutKey
                  k="/"
                  className="ml-1 -mr-0.5 border-text-dimmed/40 text-text-dimmed"
                />
              </div>
            </div>
          </div>
        </div>
        <div className="flex rounded text-text-bright h-6 bg-segmented-track w-fit">
          <div className="flex h-full w-full items-center justify-between gap-x-0.5">
            {segments.map((s, i) => (
              <Segment key={i} size="small" mark={s.mark} selected={i === 0}>
                {s.kind ? (
                  <span className="-mx-0.5 flex items-center justify-center">
                    <TaskKindIcon kind={s.kind} />
                  </span>
                ) : (
                  <span className="flex items-center justify-center">All</span>
                )}
              </Segment>
            ))}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-1.5">
        <Button
          variant="primary"
          icon={I.PlusIcon}
          iconClassName="-ml-1 mr-[-0.7rem]"
          className="pl-1.5"
          mark="new-task"
          markBadge="left"
        >
          New task…
        </Button>
      </div>
    </div>
  );
}

export function TasksListFigure() {
  return (
    <AppFrame menu={<SideMenu active="Tasks" open={[]} />}>
      <PageHeader
        title="Tasks"
        accessory={
          <div className="h-fit">
            <I.QuestionMarkIcon className="size-4 text-text-dimmed" />
          </div>
        }
      >
        <Button variant="docs" icon={I.BookIcon}>
          Task docs
        </Button>
      </PageHeader>
      <Toolbar />
      <div className="whitespace-nowrap overflow-hidden border-t">
        <div className="table w-full">
          <div className={tableHeader}>
            <div className="table-row relative w-full">
              <div className={th}>ID</div>
              <div className={th}>
                <div className="flex items-center gap-1">
                  Type
                  <span className="h-fit">
                    <I.InformationCircleIcon className="size-3.5 text-text-dimmed flex-0" />
                  </span>
                </div>
              </div>
              <div className={th}>File</div>
              <div className={th}>Running</div>
              <div className={th}>Activity (24h)</div>
              <div className={th} />
            </div>
          </div>
          <div className="table-row-group relative">
            {tasks.map((task) => (
              <div key={task.slug} className={tableRow}>
                <Cell>
                  <div
                    className="flex items-center gap-2"
                    data-mark={task.mark ? "scheduled-task" : undefined}
                  >
                    <TaskKindIcon kind={task.kind} />
                    <span>{task.slug}</span>
                  </div>
                </Cell>
                <Cell>
                  <div className="flex items-center gap-2">
                    <span>{task.kind === "SCHEDULED" ? "Scheduled" : "Standard"}</span>
                  </div>
                </Cell>
                <Cell>
                  <span className="px-1 py-0.5 rounded border border-grid-bright bg-background-bright font-mono text-wrap text-xxs text-text-dimmed">
                    {task.file}
                  </span>
                </Cell>
                <Cell>0</Cell>
                <Cell pad="px-3 py-1.5">
                  <div style={{ width: 146, height: 24 }}>
                    <ActivitySparkline ok={task.ok} failed={task.failed} />
                  </div>
                </Cell>
                {/* TableCellMenu, sticky to the right edge. The Test button beside the menu only
                    shows on hover. */}
                <div className={`${td} text-right sticky right-0 bg-background-dimmed`}>
                  <div className="relative h-full p-1">
                    <div className="absolute right-0 top-1/2 mr-1 flex -translate-y-1/2 items-center justify-end gap-0.5 rounded-[0.25rem] p-0.5 bg-background-dimmed">
                      <div className="group flex items-center justify-center size-6 rounded-[3px] text-text-dimmed">
                        <I.EllipsisVerticalIcon className="size-5" />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </AppFrame>
  );
}

import { CircleStackIcon } from "@heroicons/react/20/solid";
import { Form, useNavigate } from "@remix-run/react";
import { useCallback, useState } from "react";
import { LogoIcon } from "~/components/LogoIcon";
import { Button } from "~/components/primitives/Buttons";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectLinkItem,
  shortcutFromIndex,
} from "~/components/primitives/Select";
import {
  TaskRunStatusCombo,
  allTaskRunStatuses,
  runStatusTitle,
} from "~/components/runs/v3/TaskRunStatus";
import { useOptimisticLocation } from "~/hooks/useOptimisticLocation";

const branches = [
  "main",
  "0.10-stable",
  "0.11-stable",
  "0.12-stable",
  "0.13-stable",
  "0.14-stable",
  "15-stable",
  "15.6-dev",
  "16.3-dev",
  "16.4.2-dev",
  "16.8.3",
  "16.8.4",
  "16.8.5",
  "16.8.6",
  "17.0.0-dev",
  "builds/facebook-www",
  "devtools-v4-merge",
  "fabric-cleanup",
  "fabric-focus-blur",
  "gh-pages",
  "leg",
  "nativefb-enable-cache",
  "nov-main-trigger",
  "rsckeys",
];

export default function Story() {
  return (
    <div className="flex h-full max-w-full flex-wrap items-start justify-start gap-2 px-4 py-16">
      <Form className="space-y-4">
        <div className="flex gap-16">
          <ProjectSelector />
          <Statuses />

          <Select name="static" text="Static" defaultValue={[]} shortcut={{ key: "e" }}>
            <SelectItem value={"value"} shortcut={{ key: "1" }}>
              Item 1
            </SelectItem>
            <SelectItem value={"value2"} shortcut={{ key: "2" }}>
              Item 2
            </SelectItem>
          </Select>

          <Select
            variant="tertiary/medium"
            text="Tertiary medium"
            defaultValue={[]}
            shortcut={{ key: "e" }}
          >
            <SelectItem value={"value"} shortcut={{ key: "1" }}>
              Item 1
            </SelectItem>
            <SelectItem value={"value2"} shortcut={{ key: "2" }}>
              Item 2
            </SelectItem>
          </Select>

          <Select variant="minimal/small" text="Minimal" defaultValue={[]} shortcut={{ key: "e" }}>
            <SelectItem value={"value"} shortcut={{ key: "1" }}>
              Item 1
            </SelectItem>
            <SelectItem value={"value2"} shortcut={{ key: "2" }}>
              Item 2
            </SelectItem>
          </Select>

          <Select
            variant="minimal/medium"
            text="Tertiary medium"
            defaultValue={[]}
            shortcut={{ key: "e" }}
          >
            <SelectItem value={"value"} shortcut={{ key: "1" }}>
              Item 1
            </SelectItem>
            <SelectItem value={"value2"} shortcut={{ key: "2" }}>
              Item 2
            </SelectItem>
          </Select>

          <Select
            name="static"
            text="Heading"
            defaultValue={[]}
            showHeading={true}
            heading="A heading"
            shortcut={{ key: "h" }}
          >
            <SelectItem value={"value"} shortcut={{ key: "1" }}>
              Item 1
            </SelectItem>
            <SelectItem value={"value2"} shortcut={{ key: "2" }}>
              Item 2
            </SelectItem>
          </Select>

          <Select
            name="branch2"
            heading={"Filter by status..."}
            defaultValue={"main"}
            items={branches}
          >
            {(matches) => matches?.map((value) => <SelectItem key={value} value={value} />)}
          </Select>

          <Button variant="tertiary/small">Submit</Button>
        </div>
      </Form>
    </div>
  );
}

const statuses = allTaskRunStatuses.map((status) => ({
  title: runStatusTitle(status),
  value: status,
}));

function Statuses() {
  const navigate = useNavigate();
  const location = useOptimisticLocation();
  const search = new URLSearchParams(location.search);

  const handleChange = useCallback((values: string[]) => {
    search.delete("status");
    for (const value of values) {
      search.append("status", value);
    }
    navigate(`${location.pathname}?${search.toString()}`, { replace: true });
  }, []);

  return (
    <Select
      name="status"
      text="Status"
      value={search.getAll("status")}
      setValue={handleChange}
      heading={"Filter by status..."}
      items={statuses}
      filter={(item, search) => item.title.toLowerCase().includes(search.toLowerCase())}
      shortcut={{ key: "s" }}
    >
      {(matches, { shortcutsEnabled }) => (
        <>
          {matches?.map((item, index) => (
            <SelectItem
              key={item.value}
              value={item.value}
              shortcut={shortcutFromIndex(index, { shortcutsEnabled })}
            >
              <TaskRunStatusCombo status={item.value} iconClassName="animate-none" />
            </SelectItem>
          ))}
        </>
      )}
    </Select>
  );
}

export const projects = [
  {
    type: "section" as const,
    title: "Apple",
    items: [
      {
        title: "iTunes",
        value: "itunes",
      },
      {
        title: "App Store",
        value: "appstore",
      },
    ],
  },
  {
    type: "section" as const,
    title: "Google",
    items: [
      {
        title: "Maps",
        value: "maps",
      },
      {
        title: "Gmail",
        value: "gmail",
      },
      {
        title: "Waymo",
        value: "waymo",
      },
      {
        title: "Android",
        value: "android",
      },
    ],
  },
  {
    type: "section" as const,
    title: "Uber",
    items: [
      {
        title: "Planner",
        value: "planner",
      },
    ],
  },
];

function ProjectSelector() {
  const location = useOptimisticLocation();
  const search = new URLSearchParams(location.search);

  const selected = projects
    .find((p) => p.items.some((i) => i.value === search.get("project")))
    ?.items.find((i) => i.value === search.get("project"));

  const searchParams = new URLSearchParams(location.search);
  searchParams.delete("project");

  return (
    <Select
      name="project"
      defaultValue={selected?.value}
      text={selected?.title}
      heading="Find project..."
      icon={<LogoIcon className="h-3 w-3" />}
      items={projects}
      shortcut={{ key: "p", modifiers: ["alt"] }}
      filter={(item, search, sectionTitle) =>
        sectionTitle?.toLowerCase().includes(search.toLowerCase()) ||
        item.title.toLowerCase().includes(search.toLowerCase())
      }
    >
      {(matches, { shortcutsEnabled, section }) => (
        <SelectGroup>
          {section && <SelectGroupLabel>{section.title}</SelectGroupLabel>}
          {matches?.map((match, index) => (
            <SelectLinkItem
              icon={<CircleStackIcon className="size-3" />}
              key={match.value}
              value={match.value}
              to={`?${searchParams.toString()}&project=${match.value}`}
              shortcut={shortcutFromIndex(index, { shortcutsEnabled, section })}
            >
              {match.title}
            </SelectLinkItem>
          ))}
        </SelectGroup>
      )}
    </Select>
  );
}

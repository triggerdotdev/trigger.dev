import { CircleStackIcon } from "@heroicons/react/20/solid";
import { Form, useNavigate } from "@remix-run/react";
import clsx from "clsx";
import e from "express";
import { matchSorter } from "match-sorter";
import { ComponentProps, useCallback, useMemo, useState } from "react";
import { Button } from "~/components/primitives/Buttons";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectSeparator,
  shortcutFromIndex,
} from "~/components/primitives/Listbox";
import {
  TaskRunStatusCombo,
  allTaskRunStatuses,
  runStatusTitle,
} from "~/components/runs/v3/TaskRunStatus";
import { useOptimisticLocation } from "~/hooks/useOptimisticLocation";

export const branches = [
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

export const grouped = [
  {
    type: "section" as const,
    title: "My org",
    items: [
      {
        title: "My repo",
        value: "main",
      },
      {
        title: "My fork",
        value: "fork",
      },
    ],
  },
  {
    type: "section" as const,
    title: "Other org",
    items: [
      {
        title: "Other repo",
        value: "other2",
      },
      {
        title: "Other fork",
        value: "fork2",
      },
    ],
  },
];

export const groupedNoTitles = [
  {
    type: "section" as const,
    title: "My org",
    items: [
      {
        title: "My repo",
        value: "main",
      },
      {
        title: "My fork",
        value: "fork",
      },
    ],
  },
  {
    type: "section" as const,
    items: [
      {
        title: "Other repo",
        value: "other2",
      },
      {
        title: "Other fork",
        value: "fork2",
      },
    ],
  },
];

export default function Story() {
  const [value, setValue] = useState(["main"]);

  return (
    <div className="flex h-full max-w-full flex-wrap items-start justify-start gap-2 px-4 py-16">
      <Form className="space-y-4">
        <div className="flex gap-16">
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
            name="branch2"
            value={value}
            setValue={setValue}
            heading={"Filter by status..."}
            items={branches}
          >
            {(matches) => matches?.map((value) => <SelectItem key={value} value={value} />)}
          </Select>

          <Select
            name="grouped"
            defaultValue={["main"]}
            heading={"Filter by status..."}
            items={grouped}
            filter={(item, search, sectionTitle) =>
              sectionTitle?.toLowerCase().includes(search.toLowerCase()) ||
              item.title.toLowerCase().includes(search.toLowerCase())
            }
          >
            {(matches, showShortcut, title) => (
              <SelectGroup>
                {title && <SelectGroupLabel>{title}</SelectGroupLabel>}
                {matches?.map((match) => (
                  <SelectItem key={match.value} value={match.value}>
                    {match.title}
                  </SelectItem>
                ))}
              </SelectGroup>
            )}
          </Select>

          <Select
            name="grouped"
            defaultValue={["main"]}
            text="No titles"
            heading={"Filter by status..."}
            items={groupedNoTitles}
            filter={(item, search, sectionTitle) =>
              sectionTitle?.toLowerCase().includes(search.toLowerCase()) ||
              item.title.toLowerCase().includes(search.toLowerCase())
            }
          >
            {(matches, showShortcut, title) => (
              <SelectGroup>
                {title ? <SelectGroupLabel>{title}</SelectGroupLabel> : <SelectSeparator />}
                {matches?.map((match) => (
                  <SelectItem key={match.value} value={match.value}>
                    {match.title}
                  </SelectItem>
                ))}
              </SelectGroup>
            )}
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
      shortcut={{ key: "s" }}
      filter={(item, search) => item.title.toLowerCase().includes(search.toLowerCase())}
    >
      {(matches, showShortcut, title) => (
        <>
          {matches?.map((item, index) => (
            <SelectItem
              key={item.value}
              value={item.value}
              shortcut={shortcutFromIndex(index, showShortcut)}
            >
              <TaskRunStatusCombo status={item.value} iconClassName="animate-none" />
            </SelectItem>
          ))}
        </>
      )}
    </Select>
  );
}

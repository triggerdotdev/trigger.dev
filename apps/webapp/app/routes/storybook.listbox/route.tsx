import { Form } from "@remix-run/react";
import clsx from "clsx";
import { matchSorter } from "match-sorter";
import { ComponentProps, useMemo, useState } from "react";
import { Button } from "~/components/primitives/Buttons";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectSeparator,
} from "~/components/primitives/Listbox";

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
    <div className="flex h-full max-w-full flex-wrap items-start justify-start gap-2 p-4">
      <Form className="space-y-4">
        <div className="flex gap-4">
          <Select name="static" text="Static" defaultValue={[]} shortcut={{ key: "s" }}>
            <SelectItem value={"value"} shortcut={{ key: "1" }}>
              Item 1
            </SelectItem>
            <SelectItem value={"value2"} shortcut={{ key: "2" }}>
              Item 2
            </SelectItem>
          </Select>

          <Select
            name="branch"
            text="Branches"
            icon={<BranchIcon />}
            // value={value}
            // setValue={setValue}
            defaultValue={["main"]}
            heading={"Filter by status..."}
            items={branches}
            shortcut={{ key: "b" }}
            filter={(item, search) => item.toLowerCase().includes(search.toLowerCase())}
          >
            {(matches, title) => (
              <>
                {matches?.map((value) => (
                  <SelectItem key={value} value={value} />
                ))}
              </>
            )}
          </Select>

          <Select
            name="branch2"
            // icon={<BranchIcon />}
            value={value}
            setValue={setValue}
            heading={"Filter by status..."}
            items={branches}
          >
            {(matches) => matches?.map((value) => <SelectItem key={value} value={value} />)}
          </Select>

          <Select
            name="grouped"
            icon={<BranchIcon />}
            // value={value}
            // setValue={setValue}
            defaultValue={["main"]}
            heading={"Filter by status..."}
            items={grouped}
            filter={(item, search, sectionTitle) =>
              sectionTitle?.toLowerCase().includes(search.toLowerCase()) ||
              item.title.toLowerCase().includes(search.toLowerCase())
            }
          >
            {(matches, title) => (
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
            icon={<BranchIcon />}
            // value={value}
            // setValue={setValue}
            defaultValue={["main"]}
            text="No titles"
            heading={"Filter by status..."}
            items={groupedNoTitles}
            filter={(item, search, sectionTitle) =>
              sectionTitle?.toLowerCase().includes(search.toLowerCase()) ||
              item.title.toLowerCase().includes(search.toLowerCase())
            }
          >
            {(matches, title) => (
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
        </div>

        <Button variant="tertiary/medium">Submit</Button>
      </Form>
    </div>
  );
}

function BranchIcon(props: ComponentProps<"svg">) {
  return (
    <svg
      fill="currentColor"
      strokeWidth="0"
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      aria-hidden
      {...props}
      className={clsx("flex-none opacity-70 [[data-active-item]>&]:opacity-100", props.className)}
    >
      <path d="M15 4.75a3.25 3.25 0 1 1 6.5 0 3.25 3.25 0 0 1-6.5 0ZM2.5 19.25a3.25 3.25 0 1 1 6.5 0 3.25 3.25 0 0 1-6.5 0Zm0-14.5a3.25 3.25 0 1 1 6.5 0 3.25 3.25 0 0 1-6.5 0ZM5.75 6.5a1.75 1.75 0 1 0-.001-3.501A1.75 1.75 0 0 0 5.75 6.5Zm0 14.5a1.75 1.75 0 1 0-.001-3.501A1.75 1.75 0 0 0 5.75 21Zm12.5-14.5a1.75 1.75 0 1 0-.001-3.501A1.75 1.75 0 0 0 18.25 6.5Z" />
      <path d="M5.75 16.75A.75.75 0 0 1 5 16V8a.75.75 0 0 1 1.5 0v8a.75.75 0 0 1-.75.75Z" />
      <path d="M17.5 8.75v-1H19v1a3.75 3.75 0 0 1-3.75 3.75h-7a1.75 1.75 0 0 0-1.75 1.75H5A3.25 3.25 0 0 1 8.25 11h7a2.25 2.25 0 0 0 2.25-2.25Z" />
    </svg>
  );
}

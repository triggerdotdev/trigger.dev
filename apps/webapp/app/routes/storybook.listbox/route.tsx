import { Form } from "@remix-run/react";
import clsx from "clsx";
import { matchSorter } from "match-sorter";
import { ComponentProps, useMemo, useState } from "react";
import { Button } from "~/components/primitives/Buttons";
import { Select, SelectItem } from "~/components/primitives/Listbox";

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

export default function Story() {
  const [data, setData] = useState(branches);
  const [value, setValue] = useState(["main"]);
  const [searchValue, setSearchValue] = useState("");
  const values = data;

  const matches = useMemo(() => {
    if (!values) return [];
    if (!searchValue) return values;
    console.log("values", values);
    return matchSorter(values, searchValue);
  }, [values, searchValue]);

  const placeholder = "Find or create a branch...";

  const canAddBranch = !!searchValue && !matches.includes(searchValue);

  const empty = !matches.length && <div className="py-6 text-center">No matches found</div>;

  return (
    <div className="flex max-w-full flex-wrap justify-center gap-2 p-4">
      {/* <Select
        label={<div hidden>Select</div>}
        icon={<BranchIcon />}
        value={value}
        setValue={setValue}
      >
        <SelectList>
          {values?.map((value) => (
            <SelectItem key={value} value={value} />
          ))}
        </SelectList>
      </Select> */}
      <Form>
        <Select
          name="branch"
          icon={<BranchIcon />}
          value={value}
          setValue={setValue}
          heading={"Why hello there"}
          // filter={{
          //   items: values,
          //   fn: (item, search) => item.toLowerCase().includes(search.toLowerCase()),
          // }}
        >
          {matches?.map((value) => (
            <SelectItem key={value} value={value} />
          ))}
          {matches.length === 0 ? empty : null}
        </Select>

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

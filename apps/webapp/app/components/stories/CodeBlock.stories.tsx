import type { Meta, StoryObj } from "@storybook/react";
import { withDesign } from "storybook-addon-designs";
import { CodeBlock } from "../code/CodeBlock";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "~/utils/cn";

const meta: Meta<typeof CodeBlock> = {
  title: "code/CodeBlock",
  component: CodeBlock,
  decorators: [withDesign],
  tags: ["autodocs"],
};

export default meta;

type Story = StoryObj<typeof CodeBlock>;

export const Block: Story = {
  args: {
    code: `export const client = new TriggerClient("smoke-test", {
  apiUrl: "http://localhost:3000",
  endpoint: "http://localhost:3007/__trigger/entry",
  logLevel: "debug",
  longLine: "This is a long line that will scroll off the edge of the screen and cause a horizontal scrollbar",
  onLog: (log) => {
    console.log(log);
  },
  onLogError: (log) => {
    console.error(log);
  },
  onLogWarning: (log) => {
    console.warn(log);
  },
  onLogInfo: (log) => {
    console.info(log);
  },
});`,
    highlightedRanges: [
      [6, 8],
      [12, 14],
    ],
  },

  render: (args) => <CodeBlock {...args} />,
};

Block.parameters = {
  design: {
    type: "figma",
    url: "https://www.figma.com/file/LKQ4FJ4bTnCSjedbRpk931/Sample-File",
  },
};

export const OneLiner: Story = {
  args: {
    code: `{ id: "my-first-job" }`,
    showLineNumbers: false,
  },

  render: (args) => <CodeBlock {...args} />,
};

export const AnimatedLineHighlighting: Story = {
  args: {
    code: `{ id: "my-first-job" }`,
    showLineNumbers: false,
  },

  render: (args) => <AnimatedHighlight />,
};

const highlightedRegions: { title: string; range?: [number, number][] }[] = [
  {
    title: "When a Stripe payment fails",
    range: [
      [1, 2],
      [4, 4],
    ],
  },
  {
    title: ", ",
  },
  {
    title: "schedule an email to the user",
    range: [[6, 8]],
  },
  {
    title: ", and ",
  },
  {
    title: "send a notification to the admin",
    range: [[10, 12]],
  },
  {
    title: ".",
  },
];

const code = `export const client = new TriggerClient("smoke-test", {
  apiUrl: "http://localhost:3000",
  endpoint: "http://localhost:3007/__trigger/entry",
  logLevel: "debug",
  longLine: "This is a long line that will scroll off the edge of the screen and cause a horizontal scrollbar",
  onLog: (log) => {
    console.log(log);
  },
  onLogError: (log) => {
    console.error(log);
  },
  onLogWarning: (log) => {
    console.warn(log);
  },
  onLogInfo: (log) => {
    console.info(log);
  },
});`;

function AnimatedHighlight() {
  const firstRange = highlightedRegions.findIndex((region) => region.range);
  const [highlighted, setHighlighted] = useState<number>(firstRange);
  const [shouldAnimate, setShouldAnimate] = useState<boolean>(true);
  const interval = useRef<NodeJS.Timer>();

  useEffect(() => {
    clearInterval(interval.current);
    interval.current = setInterval(() => {
      if (shouldAnimate) {
        let nextIndex = highlightedRegions.findIndex((v, i) => {
          return i > highlighted && v.range;
        });
        if (nextIndex === -1) {
          nextIndex = highlightedRegions.findIndex((region) => region.range);
        }
        setHighlighted(nextIndex);
      }
    }, 2000);
  }, [highlighted, shouldAnimate]);

  const highlightedRanges = highlightedRegions[highlighted]?.range
    ? highlightedRegions[highlighted].range!
    : [];

  return (
    <div className="flex gap-2">
      <p className="w-96">
        {highlightedRegions.map((region, index) => (
          <span
            key={index}
            onMouseEnter={() => {
              if (region.range) {
                setHighlighted(index);
                setShouldAnimate(false);
              }
              setShouldAnimate(false);
            }}
            onMouseLeave={() => {
              setShouldAnimate(true);
              interval.current?.refresh();
            }}
            className={cn(
              "transition-bg text-xl transition-colors duration-300",
              region.range
                ? "cursor-pointer rounded px-1 text-indigo-500"
                : "text-slate-500",
              highlighted === index && "bg-indigo-500 text-white"
            )}
          >
            {region.title}
          </span>
        ))}
      </p>
      <div
        onMouseEnter={() => {
          setHighlighted(-1);
          setShouldAnimate(false);
        }}
        onMouseLeave={() => {
          setShouldAnimate(true);
          setHighlighted(
            highlightedRegions.findIndex((region) => region.range)
          );
        }}
      >
        <CodeBlock code={code} highlightedRanges={highlightedRanges} />
      </div>
    </div>
  );
}

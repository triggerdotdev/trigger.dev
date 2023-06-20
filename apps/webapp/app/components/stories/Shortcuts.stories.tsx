import type { Meta, StoryObj } from "@storybook/react";
import { Switch } from "../primitives/Switch";
import { ShortcutKey } from "../primitives/ShortcutKey";
import { ShortcutDefinition } from "~/hooks/useShortcutKeys";

const meta: Meta = {
  title: "Primitives/ShortcutKey",
};

export default meta;

type Story = StoryObj<typeof Collection>;

export const ShortcutKeys: Story = {
  render: () => <Collection />,
};

const shortcuts: ShortcutDefinition[] = [
  { all: { key: "esc" } },
  { all: { key: "f" } },
  { all: { key: "f", modifiers: ["meta"] } },
  { all: { key: "k", modifiers: ["meta"] } },
  { all: { key: "del", modifiers: ["alt", "ctrl"] } },
];

function Collection() {
  return (
    <div className="flex flex-col items-start gap-y-4 p-4">
      {shortcuts.map((shortcut, index) => (
        <div key={index} className="flex gap-x-4">
          <ShortcutKey shortcut={shortcut} variant="small" />
          <ShortcutKey shortcut={shortcut} variant="medium" />
        </div>
      ))}
    </div>
  );
}

import type { Meta, StoryObj } from "@storybook/react";
import { Switch } from "../primitives/Switch";
import { ShortcutKey } from "../primitives/ShortcutKey";
import { ShortcutDefinition } from "~/hooks/useShortcutKeys";
import { Button } from "../primitives/Buttons";
import { OperatingSystemContextProvider } from "../primitives/OperatingSystemProvider";
import { Header1 } from "../primitives/Headers";

const meta: Meta = {
  title: "Primitives/ShortcutKey",
};

export default meta;

type Story = StoryObj<typeof Collection>;

export const ShortcutKeys: Story = {
  render: () => <Collection />,
};

const shortcuts: ShortcutDefinition[] = [
  { key: "esc" },
  { key: "f" },
  { key: "f", modifiers: ["meta"] },
  { key: "k", modifiers: ["meta"] },
  { key: "del", modifiers: ["ctrl", "alt"] },
  { key: "enter", modifiers: ["meta"] },
  { key: "enter", modifiers: ["mod"] },
];

function Collection() {
  return (
    <div className="flex flex-col items-start gap-y-4">
      <Set platform="mac" />
      <Set platform="windows" />
    </div>
  );
}

function Set({ platform }: { platform: "mac" | "windows" }) {
  return (
    <OperatingSystemContextProvider platform={platform}>
      <Header1>{platform}</Header1>
      {shortcuts.map((shortcut, index) => (
        <div key={index} className="flex items-center gap-x-2">
          <ShortcutKey shortcut={shortcut} variant="small" />
          <ShortcutKey shortcut={shortcut} variant="medium" />
          <Button variant="primary/small" shortcut={shortcut}>
            Primary small
          </Button>
          <Button variant="secondary/small" shortcut={shortcut}>
            Secondary small
          </Button>
          <Button variant="tertiary/small" shortcut={shortcut}>
            Tertiary small
          </Button>
          <Button variant="danger/small" shortcut={shortcut}>
            Danger small
          </Button>
          <Button variant="primary/medium" shortcut={shortcut}>
            Primary medium
          </Button>
          <Button variant="secondary/medium" shortcut={shortcut}>
            Secondary medium
          </Button>
          <Button variant="tertiary/medium" shortcut={shortcut}>
            Tertiary medium
          </Button>
          <Button variant="danger/medium" shortcut={shortcut}>
            Danger medium
          </Button>
          <Button variant="danger/medium" shortcut={shortcut}>
            Danger medium
          </Button>
        </div>
      ))}
    </OperatingSystemContextProvider>
  );
}

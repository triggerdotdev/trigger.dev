import { Button } from "~/components/primitives/Buttons";
import { Header1 } from "~/components/primitives/Headers";
import { OperatingSystemContextProvider } from "~/components/primitives/OperatingSystemProvider";
import { ShortcutKey } from "~/components/primitives/ShortcutKey";
import { ShortcutDefinition } from "~/hooks/useShortcutKeys";

const shortcuts: ShortcutDefinition[] = [
  { key: "esc" },
  { key: "f" },
  { key: "f", modifiers: ["mod"] },
  { key: "k", modifiers: ["mod"] },
  { key: "del", modifiers: ["ctrl", "alt"] },
  { key: "f", modifiers: ["shift"] },
  { key: "enter", modifiers: ["mod"] },
  { key: "enter", modifiers: ["mod"] },
  { key: "g", modifiers: ["meta"] },
];

export default function Story() {
  return (
    <div className="flex flex-col items-start gap-y-4 p-12">
      <Collection platform="mac" />
      <Collection platform="windows" />
    </div>
  );
}

function Collection({ platform }: { platform: "mac" | "windows" }) {
  return (
    <OperatingSystemContextProvider platform={platform}>
      <Header1>{platform}</Header1>
      {shortcuts.map((shortcut, index) => (
        <div key={index} className="flex items-center gap-x-2">
          <ShortcutKey shortcut={shortcut} variant="small" />
          <ShortcutKey shortcut={shortcut} variant="medium" />
          <ShortcutKey shortcut={shortcut} variant="medium/bright" />
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

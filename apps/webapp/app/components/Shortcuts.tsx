import { Keyboard } from "lucide-react";
import { Header3 } from "./primitives/Headers";
import { Paragraph } from "./primitives/Paragraph";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "./primitives/SheetV3";
import { ShortcutKey } from "./primitives/ShortcutKey";
import { Button } from "./primitives/Buttons";

export function Shortcuts() {
  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button
          variant="small-menu-item"
          LeadingIcon={Keyboard}
          leadingIconClassName="text-blue-500"
          data-action="shortcuts"
          fullWidth
          textAlignLeft
          shortcut={{ modifiers: ["shift"], key: "?" }}
          className="gap-x-0 pl-0.5"
          iconSpacing="gap-x-0.5"
        >
          Shortcuts
        </Button>
      </SheetTrigger>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>
            <div className="flex items-center gap-x-2">
              <Keyboard className="size-5 text-indigo-500" />
              <span className="font-sans text-base font-medium text-text-bright">
                Keyboard shortcuts
              </span>
            </div>
          </SheetTitle>
          <div className="space-y-6 px-4 pb-4 pt-2">
            <div className="space-y-3">
              <Header3>General</Header3>
              <Shortcut name="Close">
                <ShortcutKey shortcut={{ key: "esc" }} variant="medium/bright" />
              </Shortcut>
              <Shortcut name="Confirm">
                <ShortcutKey shortcut={{ modifiers: ["mod"] }} variant="medium/bright" />
                <ShortcutKey shortcut={{ key: "enter" }} variant="medium/bright" />
              </Shortcut>
              <Shortcut name="Filter">
                <ShortcutKey shortcut={{ key: "f" }} variant="medium/bright" />
              </Shortcut>
              <Shortcut name="Select filter">
                <ShortcutKey shortcut={{ key: "1" }} variant="medium/bright" />
                <Paragraph variant="small" className="ml-1.5">
                  to
                </Paragraph>
                <ShortcutKey shortcut={{ key: "9" }} variant="medium/bright" />
              </Shortcut>
              <Shortcut name="Previous page">
                <ShortcutKey shortcut={{ key: "j" }} variant="medium/bright" />
              </Shortcut>
              <Shortcut name="Next page">
                <ShortcutKey shortcut={{ key: "k" }} variant="medium/bright" />
              </Shortcut>
              <Shortcut name="Help & Feedback">
                <ShortcutKey shortcut={{ key: "h" }} variant="medium/bright" />
              </Shortcut>
            </div>
            <div className="space-y-3">
              <Header3>Runs page</Header3>
              <Shortcut name="Bulk action: Cancel runs">
                <ShortcutKey shortcut={{ key: "c" }} variant="medium/bright" />
              </Shortcut>
              <Shortcut name="Bulk action: Replay runs">
                <ShortcutKey shortcut={{ key: "r" }} variant="medium/bright" />
              </Shortcut>
              <Shortcut name="Bulk action: Clear selection">
                <ShortcutKey shortcut={{ key: "esc" }} variant="medium/bright" />
              </Shortcut>
            </div>
            <div className="space-y-3">
              <Header3>Run page</Header3>
              <Shortcut name="Replay run">
                <ShortcutKey shortcut={{ key: "r" }} variant="medium/bright" />
              </Shortcut>
              <Shortcut name="Overview">
                <ShortcutKey shortcut={{ key: "o" }} variant="medium/bright" />
              </Shortcut>
              <Shortcut name="Details">
                <ShortcutKey shortcut={{ key: "d" }} variant="medium/bright" />
              </Shortcut>
              <Shortcut name="Context">
                <ShortcutKey shortcut={{ key: "c" }} variant="medium/bright" />
              </Shortcut>
              <Shortcut name="Metadata">
                <ShortcutKey shortcut={{ key: "m" }} variant="medium/bright" />
              </Shortcut>
              <Shortcut name="Navigate">
                <ShortcutKey shortcut={{ key: "arrowup" }} variant="medium/bright" />
                <ShortcutKey shortcut={{ key: "arrowdown" }} variant="medium/bright" />
                <ShortcutKey shortcut={{ key: "arrowleft" }} variant="medium/bright" />
                <ShortcutKey shortcut={{ key: "arrowright" }} variant="medium/bright" />
              </Shortcut>
              <Shortcut name="Expand all">
                <ShortcutKey shortcut={{ key: "e" }} variant="medium/bright" />
              </Shortcut>
              <Shortcut name="Collapse all">
                <ShortcutKey shortcut={{ key: "w" }} variant="medium/bright" />
              </Shortcut>
              <Shortcut name="Toggle level">
                <ShortcutKey shortcut={{ key: "0" }} variant="medium/bright" />
                <Paragraph variant="small" className="ml-1.5">
                  to
                </Paragraph>
                <ShortcutKey shortcut={{ key: "9" }} variant="medium/bright" />
              </Shortcut>
            </div>
            <div className="space-y-3">
              <Header3>Schedules page</Header3>
              <Shortcut name="New schedule">
                <ShortcutKey shortcut={{ key: "n" }} variant="medium/bright" />
              </Shortcut>
            </div>
            <div className="space-y-3">
              <Header3>Alerts page</Header3>
              <Shortcut name="New alert">
                <ShortcutKey shortcut={{ key: "n" }} variant="medium/bright" />
              </Shortcut>
            </div>
          </div>
        </SheetHeader>
      </SheetContent>
    </Sheet>
  );
}

function Shortcut({ children, name }: { children: React.ReactNode; name: string }) {
  return (
    <div className="flex items-center justify-between gap-x-2">
      <span className="text-sm text-text-dimmed">{name}</span>
      <span className="flex items-center gap-x-0.5">{children}</span>
    </div>
  );
}

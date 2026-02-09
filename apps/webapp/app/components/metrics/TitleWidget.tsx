import { useState } from "react";
import { PencilIcon, TrashIcon } from "@heroicons/react/20/solid";
import { cn } from "~/utils/cn";
import { Button } from "../primitives/Buttons";
import {
  Popover,
  PopoverContent,
  PopoverMenuItem,
  PopoverVerticalEllipseTrigger,
} from "../primitives/Popover";
import { Dialog, DialogContent, DialogFooter, DialogHeader } from "../primitives/Dialog";
import { DialogClose } from "@radix-ui/react-dialog";
import { Input } from "../primitives/Input";
import { InputGroup } from "../primitives/InputGroup";
import { Label } from "../primitives/Label";

export type TitleWidgetProps = {
  title: string;
  isDraggable?: boolean;
  isResizing?: boolean;
  /** Callback when rename is clicked. Receives the new title. */
  onRename?: (newTitle: string) => void;
  /** Callback when delete is clicked. */
  onDelete?: () => void;
};

export function TitleWidget({
  title,
  isDraggable,
  isResizing,
  onRename,
  onDelete,
}: TitleWidgetProps) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isRenameDialogOpen, setIsRenameDialogOpen] = useState(false);
  const [renameValue, setRenameValue] = useState(title);

  const hasMenu = onRename || onDelete;

  return (
    <div className="h-full">
      <div
        className={cn(
          "group flex h-full items-center gap-2 rounded-lg border border-grid-bright bg-background-bright px-4",
          isDraggable && "drag-handle cursor-grab active:cursor-grabbing",
          isResizing && "select-none"
        )}
      >
        <span className="min-w-0 flex-1 truncate text-lg font-medium text-text-bright">
          {title}
        </span>
        {hasMenu && (
          <div className="flex-shrink-0 opacity-0 transition-opacity group-hover:opacity-100">
            <Popover open={isMenuOpen} onOpenChange={setIsMenuOpen}>
              <PopoverVerticalEllipseTrigger isOpen={isMenuOpen} />
              <PopoverContent align="end" className="p-0">
                <div className="flex flex-col gap-1 p-1">
                  {onRename && (
                    <PopoverMenuItem
                      icon={PencilIcon}
                      title="Rename"
                      onClick={() => {
                        setRenameValue(title);
                        setIsRenameDialogOpen(true);
                        setIsMenuOpen(false);
                      }}
                    />
                  )}
                  {onDelete && (
                    <PopoverMenuItem
                      icon={TrashIcon}
                      title="Delete"
                      leadingIconClassName="text-error"
                      className="text-error hover:!bg-error/10"
                      onClick={() => {
                        onDelete();
                        setIsMenuOpen(false);
                      }}
                    />
                  )}
                </div>
              </PopoverContent>
            </Popover>
          </div>
        )}
      </div>

      {/* Rename Dialog */}
      {onRename && (
        <Dialog open={isRenameDialogOpen} onOpenChange={setIsRenameDialogOpen}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>Rename title</DialogHeader>
            <form
              className="space-y-4 pt-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (renameValue.trim()) {
                  onRename(renameValue.trim());
                  setIsRenameDialogOpen(false);
                }
              }}
            >
              <InputGroup>
                <Label>Title</Label>
                <Input
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  placeholder="Section title"
                  autoFocus
                />
              </InputGroup>
              <DialogFooter>
                <DialogClose asChild>
                  <Button variant="tertiary/medium">Cancel</Button>
                </DialogClose>
                <Button type="submit" variant="primary/medium" disabled={!renameValue.trim()}>
                  Save
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

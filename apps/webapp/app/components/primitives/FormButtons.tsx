import { cn } from "~/utils/cn";

export function FormButtons({
  cancelButton,
  confirmButton,
  className,
}: {
  cancelButton?: React.ReactNode;
  confirmButton: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex w-full flex-row-reverse items-center justify-between border-t border-grid-bright pt-4",
        className
      )}
    >
      {confirmButton} {cancelButton ? cancelButton : <div />}
    </div>
  );
}

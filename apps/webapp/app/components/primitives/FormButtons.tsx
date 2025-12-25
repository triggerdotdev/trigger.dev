import { cn } from "~/utils/cn";

export function FormButtons({
  cancelButton,
  confirmButton,
  defaultAction,
  className,
}: {
  cancelButton?: React.ReactNode;
  confirmButton: React.ReactNode;
  defaultAction?: { name: string; value: string; disabled?: boolean };
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex w-full items-center justify-between border-t border-grid-bright pt-4",
        className
      )}
    >
      {defaultAction && (
        <button
          type="submit"
          name={defaultAction.name}
          value={defaultAction.value}
          disabled={defaultAction.disabled}
          className="hidden"
          tabIndex={-1}
          aria-hidden="true"
        />
      )}
      {cancelButton ? cancelButton : <div />} {confirmButton}
    </div>
  );
}

import { cn } from "~/utils/cn";

export function CheckboxIndicator({ checked }: { checked: boolean }) {
  return (
    <div
      className={cn(
        "flex size-4 flex-none items-center justify-center rounded border",
        checked ? "border-indigo-500 bg-indigo-600" : "border-charcoal-600 bg-charcoal-700"
      )}
    >
      {checked && (
        <svg className="size-3 text-white" viewBox="0 0 12 12" fill="none">
          <path
            d="M2.5 6L5 8.5L9.5 3.5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </div>
  );
}

import { cn } from "~/utils/cn";

type TextAreaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement> & {};

export function TextArea({ className, rows, ...props }: TextAreaProps) {
  return (
    <textarea
      {...props}
      rows={rows ?? 6}
      className={cn(
        "placeholder:text-muted-foreground w-full rounded border border-charcoal-800 bg-charcoal-750 px-3 text-sm text-text-bright transition focus-custom focus-custom file:border-0 file:bg-transparent file:text-base file:font-medium hover:border-charcoal-600 hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
    />
  );
}

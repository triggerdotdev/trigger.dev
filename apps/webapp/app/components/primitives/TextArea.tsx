import { cn } from "~/utils/cn";

type TextAreaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement> & {};

export function TextArea({ className, rows, ...props }: TextAreaProps) {
  return (
    <textarea
      {...props}
      rows={rows ?? 6}
      className={cn(
        "placeholder:text-muted-foreground w-full rounded-md border border-tertiary bg-tertiary px-3 text-sm text-text-bright transition focus-custom file:border-0 file:bg-transparent file:text-base file:font-medium hover:border-charcoal-600 focus:border-transparent focus:ring-0 disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
    />
  );
}

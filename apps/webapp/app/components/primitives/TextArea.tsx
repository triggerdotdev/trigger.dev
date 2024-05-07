import { cn } from "~/utils/cn";

type TextAreaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement> & {};

export function TextArea({ className, rows, ...props }: TextAreaProps) {
  return (
    <textarea
      {...props}
      rows={rows ?? 6}
      className={cn(
        "ring-offset-background placeholder:text-muted-foreground focus:border-ring focus:ring-ring focus-visible:ring-ring w-full rounded-md border border-tertiary bg-tertiary px-3 text-sm text-text-bright transition file:border-0 file:bg-transparent file:text-base file:font-medium hover:border-charcoal-600 focus:outline-none focus:ring-2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-offset-0 disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
    />
  );
}

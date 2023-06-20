import { cn } from "~/utils/cn";

type TextAreaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement> & {};

export function TextArea({ className, rows, ...props }: TextAreaProps) {
  return (
    <textarea
      {...props}
      rows={rows ?? 6}
      className={cn(
        "w-full rounded-md border border-slate-800 bg-slate-850 px-3 text-sm text-bright ring-offset-background transition file:border-0 file:bg-transparent file:text-base file:font-medium placeholder:text-muted-foreground hover:border-slate-750 hover:bg-slate-800 focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-0 disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
    />
  );
}

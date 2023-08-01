import { cn } from "~/utils/cn";

type InputGroupProps = {
  children: React.ReactNode;
  className?: string;
  fullWidth?: boolean;
};

export function InputGroup({ children, className, fullWidth }: InputGroupProps) {
  return (
    <div
      className={cn(
        "grid w-full items-center gap-1.5",
        fullWidth ? "w-full" : "max-w-md",
        className
      )}
    >
      {children}
    </div>
  );
}

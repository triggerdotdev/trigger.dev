import { cn } from "~/utils/cn";

type InputGroupProps = {
  children: React.ReactNode;
  className?: string;
};

export function InputGroup({ children, className }: InputGroupProps) {
  return (
    <div className={cn("grid w-full max-w-sm items-center gap-1.5", className)}>
      {children}
    </div>
  );
}

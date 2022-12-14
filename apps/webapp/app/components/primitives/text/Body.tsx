export type BodyProps = {
  children: React.ReactNode;
  size?: Size;
  className?: string;
};

type Size = "regular" | "small" | "extra-small";

export function Body({ children, className, size = "regular" }: BodyProps) {
  let sizeClass = "text-base";
  switch (size) {
    case "small":
      sizeClass = "text-sm";
      break;
    case "extra-small":
      sizeClass = "text-xs";
      break;
  }

  return <p className={`font-sans ${sizeClass} ${className}`}>{children}</p>;
}

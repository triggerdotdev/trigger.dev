export type BodyProps = {
  children: React.ReactNode;
  size?: Size;
  className?: string;
};

type Size = "regular" | "small" | "extra-small";

const baseClasses = "font-sans";
const overrideClasses = "text-slate-300";

export function Body({
  children,
  className = overrideClasses,
  size = "regular",
}: BodyProps) {
  let sizeClass = "text-base";
  switch (size) {
    case "small":
      sizeClass = "text-sm";
      break;
    case "extra-small":
      sizeClass = "text-xs";
      break;
  }

  return (
    <p className={`${baseClasses} ${sizeClass} ${className}`}>{children}</p>
  );
}

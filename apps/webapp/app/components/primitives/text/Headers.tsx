export type TitleProps = {
  children: React.ReactNode;
  size?: Size;
  className?: string;
};

type Size =
  | "extra-extra-small"
  | "extra-small"
  | "small"
  | "regular"
  | "large"
  | "extra-large";

const baseClasses = "font-sans";
const overrideClasses = "text-slate-200";

export function Header1({
  children,
  className = overrideClasses,
  size = "extra-large",
}: TitleProps) {
  return (
    <h1 className={`${baseClasses} ${getSizeClassName(size)} ${className}`}>
      {children}
    </h1>
  );
}

export function Header2({
  children,
  className = overrideClasses,
  size = "large",
}: TitleProps) {
  return (
    <h2 className={`${baseClasses} ${getSizeClassName(size)} ${className}`}>
      {children}
    </h2>
  );
}

export function Header3({
  children,
  className = overrideClasses,
  size = "regular",
}: TitleProps) {
  return (
    <h3 className={`${baseClasses} ${getSizeClassName(size)} ${className}`}>
      {children}
    </h3>
  );
}

export function Header4({
  children,
  className = overrideClasses,
  size = "small",
}: TitleProps) {
  return (
    <h4 className={`${baseClasses} ${getSizeClassName(size)} ${className}`}>
      {children}
    </h4>
  );
}

function getSizeClassName(size: Size) {
  switch (size) {
    case "extra-extra-small":
      return "text-sm";
    case "extra-small":
      return "text-base";
    case "small":
      return "text-lg";
    case "large":
      return "text-2xl";
    case "extra-large":
      return "text-3xl";
    case "regular":
    default:
      return "text-xl";
  }
}

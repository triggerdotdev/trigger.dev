export type TitleProps = {
  children: React.ReactNode;
  size?: Size;
  className?: string;
};

type Size = "regular" | "small" | "large" | "extra-large";

export function Title({ children, className, size = "regular" }: TitleProps) {
  let sizeClass = "text-xl";
  switch (size) {
    case "small":
      sizeClass = "text-lg";
      break;
    case "large":
      sizeClass = "text-2xl";
      break;
    case "extra-large":
      sizeClass = "text-3xl";
      break;
  }

  return <p className={`font-sans ${sizeClass} ${className}`}>{children}</p>;
}

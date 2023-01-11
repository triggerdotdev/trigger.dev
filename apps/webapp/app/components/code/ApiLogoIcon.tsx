import type { Provider } from "internal-providers";

type Props = Omit<
  React.DetailedHTMLProps<
    React.ImgHTMLAttributes<HTMLImageElement>,
    HTMLImageElement
  >,
  "src" | "alt"
> & {
  integration?: Provider;
  size?: Size;
};

type Size =
  | "extra-small"
  | "small"
  | "regular"
  | "large"
  | "extra-large"
  | "custom";

export function ApiLogoIcon({
  className,
  integration,
  size = "extra-large",
  ...props
}: Props) {
  if (!integration) {
    return null;
  }
  return (
    <img
      className={`
        rounded bg-slate-850
        ${getSizeClassName(size)}
        ${className}
      `}
      src={integration.icon}
      alt={integration.name}
      {...props}
    />
  );
}

function getSizeClassName(size: Size) {
  switch (size) {
    case "extra-small":
      return "h-6 w-6 p-2";
    case "small":
      return "h-8 w-8 p-2";
    case "large":
      return "h-16 w-16 p-2";
    case "extra-large":
      return "h-20 w-20 p-2";
    case "custom":
      return "";
    case "regular":
    default:
      return "h-10 w-10 p-2";
  }
}

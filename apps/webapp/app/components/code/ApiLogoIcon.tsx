import type { CatalogIntegration } from "internal-providers";

type Props = Omit<
  React.DetailedHTMLProps<
    React.ImgHTMLAttributes<HTMLImageElement>,
    HTMLImageElement
  >,
  "src" | "alt"
> & {
  integration?: CatalogIntegration;
  size?: Size;
};

type Size = "extra-small" | "small" | "regular" | "large" | "extra-large";

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
        rounded p-2 bg-slate-900/50
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
      return "h-6 w-6";
    case "small":
      return "h-8 w-8";
    case "large":
      return "h-16 w-16";
    case "extra-large":
      return "h-20 w-20";
    case "regular":
    default:
      return "h-10 w-10";
  }
}

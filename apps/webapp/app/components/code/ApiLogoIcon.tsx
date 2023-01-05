import classNames from "classnames";
import type { CatalogIntegration } from "internal-catalog";

type Props = Omit<
  React.DetailedHTMLProps<
    React.ImgHTMLAttributes<HTMLImageElement>,
    HTMLImageElement
  >,
  "src" | "alt"
> & {
  integration?: CatalogIntegration;
};

export function ApiLogoIcon({ className, integration, ...props }: Props) {
  if (!integration) {
    return null;
  }
  return (
    <img
      className={classNames("rounded p-2 h-10 w-10 bg-slate-900/50", className)}
      src={integration.icon}
      alt={integration.name}
      {...props}
    />
  );
}

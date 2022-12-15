import classNames from "classnames";

const baseClasses = "p-12";

export function Container({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <div className={classNames(baseClasses, className)}>{children}</div>;
}

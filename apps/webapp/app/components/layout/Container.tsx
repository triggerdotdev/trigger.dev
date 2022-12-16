import classNames from "classnames";

const baseClasses = "px-12 py-10";

export function Container({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={classNames("overflow-y-auto", baseClasses, className)}>
      {children}
    </div>
  );
}

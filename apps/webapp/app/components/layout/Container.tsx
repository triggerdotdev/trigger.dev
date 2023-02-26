import classNames from "classnames";

const baseClasses = "px-2 py-4 md:px-8 md:py-6 lg:px-12 lg:py-10";

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

import classNames from "classnames";
import { Header1 } from "./Headers";

export function Title({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Header1 size="extra-large" className={classNames("mb-6 text-slate-200")}>
      {children}
    </Header1>
  );
}

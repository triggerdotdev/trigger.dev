import { Header2 } from "./Headers";

export function SubTitle({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Header2 size="small" className={`mb-2 text-slate-400 ${className}`}>
      {children}
    </Header2>
  );
}

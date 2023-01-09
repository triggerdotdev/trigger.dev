import { Header2 } from "./Headers";

export function SubTitle({ children }: { children: React.ReactNode }) {
  return (
    <Header2 size="small" className="mb-2 text-slate-400">
      {children}
    </Header2>
  );
}

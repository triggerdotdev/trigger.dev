import { Header1 } from "./Headers";

export function Title({ children }: { children: string }) {
  return (
    <Header1 size="extra-large" className="text-slate-200 mb-6">
      {children}
    </Header1>
  );
}

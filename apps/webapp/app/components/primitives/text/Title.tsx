import { Header1 } from "./Headers";

export function Title({ children }: { children: React.ReactNode }) {
  return (
    <Header1 size="extra-large" className="mb-6 text-slate-200">
      {children}
    </Header1>
  );
}

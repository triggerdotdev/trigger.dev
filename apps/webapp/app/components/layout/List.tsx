export type ListProps = {
  children: React.ReactNode;
};

export function List({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-hidden bg-slate-800 shadow-md sm:rounded-md mb-4">
      <ul className="divide-y divide-slate-850">{children}</ul>
    </div>
  );
}

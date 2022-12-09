export function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid grid-rows-[3rem_auto_2rem] w-full h-full">
      {children}
    </div>
  );
}

export function AppBody({ children }: { children: React.ReactNode }) {
  return <div className="overflow-y-auto">{children}</div>;
}

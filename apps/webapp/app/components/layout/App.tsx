export function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid grid-rows-[3rem_auto_1rem] w-full">{children}</div>
  );
}

export function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid grid-rows-[120px_auto_100px] w-full">{children}</div>
  );
}

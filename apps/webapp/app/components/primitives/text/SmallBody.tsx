export type SmallBodyProps = {
  children: React.ReactNode;
  className: string;
};

export function SmallBody({ children, className }: SmallBodyProps) {
  return <p className={`font-sans text-sm ${className}`}>{children}</p>;
}

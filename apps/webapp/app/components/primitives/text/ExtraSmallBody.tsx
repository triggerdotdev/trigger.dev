export type ExtraSmallBodyProps = {
  children: React.ReactNode;
  className?: string;
};

export function ExtraSmallBody({ children, className }: ExtraSmallBodyProps) {
  return <p className={`font-sans text-xs ${className}`}>{children}</p>;
}

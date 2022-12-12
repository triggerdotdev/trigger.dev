export type LargeTitleProps = {
  children: React.ReactNode;
  className?: string;
};

export function LargeTitle({ children, className }: LargeTitleProps) {
  return <p className={`font-sans text-2xl ${className}`}>{children}</p>;
}

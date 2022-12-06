export type ExtraLargeTitleProps = {
  children: React.ReactNode;
  className: string;
};

export function ExtraLargeTitle({ children, className }: ExtraLargeTitleProps) {
  return <p className={`font-sans text-2xl ${className}`}>{children}</p>;
}

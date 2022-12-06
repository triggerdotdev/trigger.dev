export type SmallTitleProps = {
  children: React.ReactNode;
  className?: string;
};

export function SmallTitle({ children, className }: SmallTitleProps) {
  return <p className={`font-sans text-lg ${className}`}>{children}</p>;
}

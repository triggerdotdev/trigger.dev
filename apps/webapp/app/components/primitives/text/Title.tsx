export type TitleProps = {
  children: React.ReactNode;
  className?: string;
};

export function Title({ children, className }: TitleProps) {
  return <p className={`font-sans text-xl ${className}`}>{children}</p>;
}

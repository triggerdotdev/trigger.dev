export type BodyProps = {
  children: React.ReactNode;
  className?: string;
};

export function Body({ children, className }: BodyProps) {
  return <p className={`font-sans text-base ${className}`}>{children}</p>;
}

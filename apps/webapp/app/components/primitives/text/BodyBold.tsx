export type BodyBoldProps = {
  children: React.ReactNode;
  className: string;
};

export function BodyBold({ children, className }: BodyBoldProps) {
  return (
    <p className={`font-sans text-base font-semibold ${className}`}>
      {children}
    </p>
  );
}

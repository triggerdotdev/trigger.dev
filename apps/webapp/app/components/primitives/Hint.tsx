import { Paragraph } from "./Paragraph";

export function Hint({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <Paragraph variant="extra-small" className={className}>
      {children}
    </Paragraph>
  );
}

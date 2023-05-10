import { Paragraph } from "./Paragraph";

export function Hint({ children }: { children: React.ReactNode }) {
  return <Paragraph variant="small">{children}</Paragraph>;
}

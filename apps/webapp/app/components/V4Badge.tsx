import { Badge } from "./primitives/Badge";

export function V4Badge() {
  return <Badge variant="extra-small">V4</Badge>;
}

export function V4Title({ children }: { children: React.ReactNode }) {
  return (
    <>
      <span>{children}</span>
      <V4Badge />
    </>
  );
}

import { Badge } from "~/components/primitives/Badge";

export default function Story() {
  return (
    <div className="flex flex-col items-start gap-y-8 p-8">
      <Badge>Default</Badge>
      <Badge variant="rounded">3</Badge>
      <Badge variant="outline-rounded">Outline rounded</Badge>
    </div>
  );
}

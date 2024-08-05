import { Badge } from "~/components/primitives/Badge";

export default function Story() {
  return (
    <div className="flex flex-col items-start gap-y-8 p-8">
      <Badge>Default</Badge>
      <div className="bg-charcoal-1000 p-4">
        <Badge variant="small">Small</Badge>
      </div>
      <Badge variant="outline">Outline</Badge>
      <Badge variant="outline-rounded">Outline rounded</Badge>
    </div>
  );
}

import { Input } from "~/components/primitives/Input";
import { TextArea } from "~/components/primitives/TextArea";

export default function Story() {
  return (
    <div className="flex gap-16">
      <div>
        <div className="m-8 flex w-64 flex-col gap-4">
          <TextArea placeholder="6 rows (default)" autoFocus />
          <Input placeholder="Input" />
          <TextArea placeholder="3 rows" rows={3} />
          <TextArea disabled placeholder="Disabled" />
        </div>
      </div>
    </div>
  );
}

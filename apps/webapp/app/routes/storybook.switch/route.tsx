import { Switch } from "~/components/primitives/Switch";

export default function Story() {
  return (
    <div className="flex flex-col items-start gap-y-4 p-4">
      <Switch variant="large" />
      <Switch variant="large" disabled />
      <Switch variant="large" label="Toggle me" />
      <Switch variant="large" label="Label position right" labelPosition="right" />
      <Switch variant="large" label="Toggle me" disabled />
      <Switch variant="small" />
      <Switch variant="small" disabled />
      <Switch variant="small" label="Toggle me" />
      <Switch variant="small" label="Toggle me" disabled />
    </div>
  );
}

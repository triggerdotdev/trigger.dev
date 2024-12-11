import { Spinner } from "~/components/primitives/Spinner";

export default function Story() {
  return (
    <div className="flex flex-col items-start gap-y-3 p-4">
      <div className="flex items-center gap-x-4 rounded-md bg-charcoal-750 px-3 py-2 text-text-bright">
        Blue: <Spinner color="blue" />
      </div>
      <div className="flex items-center gap-x-4 rounded-md bg-charcoal-750 px-3 py-2 text-text-bright">
        White: <Spinner color="white" />
      </div>
      <div className="flex items-center gap-x-4 rounded-md bg-charcoal-600 px-3 py-2 text-text-bright">
        Muted: <Spinner color="muted" />
      </div>
      <div className="flex items-center gap-x-2">
        <div className="flex items-center gap-x-4 rounded-md bg-charcoal-600 px-3 py-2 text-text-bright">
          Dark: <Spinner color="dark" />
        </div>
        <div className="flex items-center gap-x-4 rounded-md bg-primary px-2 py-2 text-text-bright">
          <Spinner color="dark" />
        </div>
      </div>
      <div className="flex items-center gap-x-4 rounded-md bg-charcoal-600 px-3 py-2 text-text-bright">
        Custom: <Spinner color={{ background: "#EA189E", foreground: "#6532F5" }} />
      </div>
    </div>
  );
}

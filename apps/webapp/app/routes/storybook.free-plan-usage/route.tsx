import { FreePlanUsage } from "~/components/billing/FreePlanUsage";

export default function Story() {
  return (
    <div className="flex h-screen flex-col items-center justify-center gap-4 p-12">
      <div className="w-fit">
        <FreePlanUsage to={""} percentage={0.1} />
      </div>
      <div className="w-fit">
        <FreePlanUsage to={""} percentage={0.5} />
      </div>
      <div className="w-fit">
        <FreePlanUsage to={""} percentage={0.75} />
      </div>
      <div className="w-fit">
        <FreePlanUsage to={""} percentage={1} />
      </div>
    </div>
  );
}

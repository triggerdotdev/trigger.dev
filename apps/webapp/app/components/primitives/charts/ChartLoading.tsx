import { Spinner } from "../Spinner";

export function ChartLoading() {
  return (
    <div className="grid h-full place-items-center">
      <Spinner className="size-6" />
    </div>
  );
}

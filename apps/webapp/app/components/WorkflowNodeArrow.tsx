import { ArrowDownIcon } from "@heroicons/react/24/solid";

export function WorkflowNodeArrow() {
  return (
    <div className="relative flex items-center justify-center mb-9">
      <ArrowDownIcon className="absolute left-[calc(50%-20px)] -top-1 h-10 w-10 text-slate-700" />
    </div>
  );
}

import { cn } from "@/utils/cn";
import { CheckCircleIcon, PlusIcon } from "@heroicons/react/24/solid";

const baseStyle =
  "flex h-16 w-full rounded-md transition hover:cursor-pointer pl-12 font-sans focus:outline-none  focus:text-slate-200";

const ToDoRowVariants = {
  add: {
    button:
      "bg-slate-900 border-slate-500 border-2 hover:border-slate-400 pr-4 focus:text-slate-200 focus:bg-slate-800",
    icon: (
      <PlusIcon className="text-slate-500 group-hover:text-slate-200 group-hover:rotate-180 transition duration-500 delay-300" />
    ),
  },
  active: {
    button:
      "bg-slate-800 text-slate-200 focus:bg-slate-700 focus:text-slate-200 hover:bg-slate-700",
    icon: <div className="rounded-full border-2 border-slate-400 h-4 w-4" />,
  },
  completed: {
    button: "bg-slate-900 text-slate-600",
    icon: <CheckCircleIcon className="text-toxic-500 focus:bg-slate-800" />,
  },
};

type ToDoRowProps = {
  className?: string;
  variant: keyof typeof ToDoRowVariants;
};

export function ToDoRow({ variant, className }: ToDoRowProps) {
  const Icon = ToDoRowVariants[variant].icon;
  return (
    <form method="GET" className="group">
      <div className="relative text-slate-400 focus-within:text-slate-900 ">
        <span className="absolute inset-y-0 left-0 flex items-center pl-2">
          <button
            type="submit"
            className="p-1 focus:outline-none focus:shadow-outline"
          >
            <div className="w-6 h-6 flex justify-center items-center">
              {Icon}
            </div>
          </button>
        </span>
        <input
          type="text"
          name="q"
          placeholder="What needs to be done?"
          className={cn(
            baseStyle,
            ToDoRowVariants[variant].button,
            "text-lg placeholder-slate-500 ",
            className
          )}
        />
      </div>
    </form>
  );
}

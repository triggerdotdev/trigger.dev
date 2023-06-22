import { cn } from "@/utils/cn";
import { CheckCircleIcon, PlusIcon } from "@heroicons/react/24/solid";
import { Paragraph } from "./Paragraph";

const baseStyle =
  "flex h-16 w-full rounded-md transition hover:cursor-pointer pl-12 font-sans focus:outline-none focus:bg-slate-600 focus:text-slate-200";

const ToDoRowVariants = {
  add: {
    button:
      "bg-slate-800 border-slate-500 border-2 hover:border-slate-400  pr-4 ",
    text: "text-slate-600 italic",
    icon: (
      <PlusIcon className="text-slate-200 group-hover:rotate-180 transition duration-500" />
    ),
  },
  active: {
    button: "bg-slate-800",
    text: "text-slate-200",
    icon: <div className="rounded-full border-2 border-slate-400 h-4 w-4" />,
  },
  completed: {
    button: "bg-slate-900",
    text: "text-slate-600",
    icon: <CheckCircleIcon className="text-green-500" />,
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
          placeholder="Search..."
          className={cn(
            baseStyle,
            ToDoRowVariants[variant].button,
            "text-lg placeholder-slate-600 focus:text-slate-200",
            className
          )}
        />
      </div>
    </form>
  );
}

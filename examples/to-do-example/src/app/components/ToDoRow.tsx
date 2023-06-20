import { cn } from "@/utils/cn";
import { CheckCircleIcon, PlusIcon } from "@heroicons/react/24/solid";
import { Paragraph } from "./Paragraph";

const baseStyle =
  "flex h-16 w-full rounded-md pl-2 pr-4 transition hover:cursor-pointer";

const ToDoRowVariants = {
  add: {
    button: "bg-slate-800 border-slate-500 border-2 hover:border-slate-400 ",
    text: "text-slate-600 italic",
    icon: <PlusIcon className="text-slate-100" />,
  },
  active: {
    button: "bg-slate-800 text-slate-100",
    text: "text-slate-400",
    icon: <div className="rounded-full border-2 border-slate-400 h-4 w-4" />,
  },
  completed: {
    button: "bg-slate-900 text-slate-100",
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
    <div className={cn(baseStyle, ToDoRowVariants[variant].button, className)}>
      <div className="flex justify-center items-center gap-2">
        <div className="w-6 h-6 flex justify-center items-center">{Icon}</div>
        <Paragraph
          variant="large"
          className={cn(ToDoRowVariants[variant].text)}
        >
          What do you want to do?
        </Paragraph>
      </div>
    </div>
  );
}

import { cn } from "@/utils/cn";

const baseStyle =
  "w-full whitespace-nowrap group bg-indigo-600 px-4 justify-center flex transition items-center rounded font-sans text-slate-200";

const ButtonVariants = {
  primary: "bg-indigo-600 hover:bg-indigo-500  ",
  secondary: "bg-slate-700 hover:bg-slate-600  ",
  disabled: "bg-indigo-800 text-indigo-500",
};

const ButtonSizes = {
  small: "h-8 text-sm gap-x-2",
  medium: "h-12 text-base gap-x-4 ",
  large: "h-16 text-lg gap-x-6",
};

type Buttonprops = {
  className?: string;
  iconLeft?: React.ReactNode;
  iconRight?: React.ReactNode;
  buttonText: string;
  active?: boolean;
  buttonVariant: keyof typeof ButtonVariants;
  buttonSize: keyof typeof ButtonSizes;
};

export function Button({
  buttonVariant,
  buttonText,
  buttonSize,
  className,
  iconLeft,
  iconRight,
}: Buttonprops) {
  return (
    <button
      className={cn(
        baseStyle,
        ButtonSizes[buttonSize],
        ButtonVariants[buttonVariant],
        className
      )}
    >
      {iconLeft}
      {buttonText}
      {iconRight}
    </button>
  );
}

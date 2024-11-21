import { ChevronLeftIcon, ChevronRightIcon } from "@heroicons/react/20/solid";
import { cn } from "~/utils/cn";

const variants = {
  small: {
    size: "size-[1rem]",
    arrowHeadRight: "group-hover:translate-x-[3px]",
    arrowLineRight: "h-[1.5px] w-[7px] translate-x-1 top-[calc(50%-0.5px)]",
    arrowHeadLeft: "group-hover:translate-x-[3px]",
    arrowLineLeft: "h-[1.5px] w-[7px] translate-x-1 top-[calc(50%-0.5px)]",
    arrowHeadTopRight:
      "-translate-x-0 transition group-hover:translate-x-[3px] group-hover:translate-y-[-3px]",
  },
  medium: {
    size: "size-[1.1rem]",
    arrowHeadRight: "group-hover:translate-x-[3px]",
    arrowLineRight: "h-[1.5px] w-[9px] translate-x-1 top-[calc(50%-1px)]",
    arrowHeadLeft: "group-hover:translate-x-[-3px]",
    arrowLineLeft: "h-[1.5px] w-[9px] translate-x-1 top-[calc(50%-1px)]",
    arrowHeadTopRight:
      "-translate-x-0 transition group-hover:translate-x-[3px] group-hover:translate-y-[-3px]",
  },
  large: {
    size: "size-6",
    arrowHeadRight: "group-hover:translate-x-1",
    arrowLineRight: "h-[2.3px] w-[12px] translate-x-[6px] top-[calc(50%-1px)]",
    arrowHeadLeft: "group-hover:translate-x-1",
    arrowLineLeft: "h-[2.3px] w-[12px] translate-x-[6px] top-[calc(50%-1px)]",
    arrowHeadTopRight:
      "-translate-x-0 transition group-hover:translate-x-[3px] group-hover:translate-y-[-3px]",
  },
  "extra-large": {
    size: "size-8",
    arrowHeadRight: "group-hover:translate-x-1",
    arrowLineRight: "h-[3px] w-[16px] translate-x-[8px] top-[calc(50%-1.5px)]",
    arrowHeadLeft: "group-hover:translate-x-1",
    arrowLineLeft: "h-[3px] w-[16px] translate-x-[8px] top-[calc(50%-1.5px)]",
    arrowHeadTopRight:
      "-translate-x-0 transition group-hover:translate-x-[3px] group-hover:translate-y-[-3px]",
  },
};

export const themes = {
  dark: {
    textStyle: "text-background-bright",
    arrowLine: "bg-background-bright",
  },
  dimmed: {
    textStyle: "text-text-dimmed",
    arrowLine: "bg-text-dimmed",
  },
  bright: {
    textStyle: "text-text-bright",
    arrowLine: "bg-text-bright",
  },
  primary: {
    textStyle: "text-text-dimmed group-hover:text-primary",
    arrowLine: "bg-text-dimmed group-hover:bg-primary",
  },
  blue: {
    textStyle: "text-text-dimmed group-hover:text-blue-500",
    arrowLine: "bg-text-dimmed group-hover:bg-blue-500",
  },
  rose: {
    textStyle: "text-text-dimmed group-hover:text-rose-500",
    arrowLine: "bg-text-dimmed group-hover:bg-rose-500",
  },
  amber: {
    textStyle: "text-text-dimmed group-hover:text-amber-500",
    arrowLine: "bg-text-dimmed group-hover:bg-amber-500",
  },
  apple: {
    textStyle: "text-text-dimmed group-hover:text-apple-500",
    arrowLine: "bg-text-dimmed group-hover:bg-apple-500",
  },
  lavender: {
    textStyle: "text-text-dimmed group-hover:text-lavender-500",
    arrowLine: "bg-text-dimmed group-hover:bg-lavender-500",
  },
};

type Variants = keyof typeof variants;
type Theme = keyof typeof themes;

type AnimatingArrowProps = {
  className?: string;
  variant?: Variants;
  theme?: Theme;
  direction?: "right" | "left" | "topRight";
};

export function AnimatingArrow({
  className,
  variant = "medium",
  theme = "dimmed",
  direction = "right",
}: AnimatingArrowProps) {
  const variantStyles = variants[variant];
  const themeStyles = themes[theme];

  return (
    <span className={cn("relative -mr-1 ml-1 flex", variantStyles.size, className)}>
      {direction === "topRight" && (
        <>
          <svg
            className={cn(
              "absolute top-[5px] transition duration-200 ease-in-out",
              themeStyles.textStyle
            )}
            width="9"
            height="8"
            viewBox="0 0 9 8"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path d="M1.5 7L7.5 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>

          <svg
            className={cn(
              "absolute top-[5px] transition duration-300 ease-in-out",
              themeStyles.textStyle,
              variantStyles.arrowHeadTopRight
            )}
            width="9"
            height="8"
            viewBox="0 0 9 8"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path d="M1 1H7.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            <path d="M7.5 7L7.5 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            <path d="M1 7.5L7.5 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </>
      )}
      {direction === "right" && (
        <>
          <span
            className={cn(
              "absolute rounded-full opacity-0 transition duration-300 ease-in-out group-hover:opacity-100",
              variantStyles.arrowLineRight,
              themeStyles.arrowLine
            )}
          />
          <ChevronRightIcon
            className={cn(
              "absolute -translate-x-0.5 transition duration-300 ease-in-out",
              variantStyles.arrowHeadRight,
              variantStyles.size,
              themeStyles.textStyle
            )}
          />
        </>
      )}
      {direction === "left" && (
        <>
          <span
            className={cn(
              "absolute rounded-full opacity-0 transition duration-300 ease-in-out group-hover:opacity-100",
              variantStyles.arrowLineLeft,
              themeStyles.arrowLine
            )}
          />
          <ChevronLeftIcon
            className={cn(
              "absolute translate-x-0.5 transition duration-300 ease-in-out",
              variantStyles.arrowHeadLeft,
              variantStyles.size,
              themeStyles.textStyle
            )}
          />
        </>
      )}
    </span>
  );
}

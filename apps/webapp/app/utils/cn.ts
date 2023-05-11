import { clsx, type ClassValue } from "clsx";
import { twMerge, extendTailwindMerge } from "tailwind-merge";

const customTwMerge = extendTailwindMerge({
  theme: {
    fontSize: ["xxs"],
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

const customTwMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      // Custom font sizes defined in tailwind.css (--text-xxs, --text-2sm)
      "font-size": [{ text: ["xxs", "2sm"] }],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return customTwMerge(clsx(inputs));
}

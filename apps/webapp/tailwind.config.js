/** @type {import('tailwindcss').Config} */
import parentConfig, {
  theme as _theme,
} from "@apihero/tailwind-config/tailwind.config";
import { slate, blue, purple } from "tailwindcss/colors";
const midnightColors = {
  1000: "#030713",
};
const toxicColors = {
  500: "#41FF54",
};
export default {
  ...parentConfig,
  theme: {
    ..._theme,
    extend: {
      ..._theme.extend,
      colors: {
        midnight: midnightColors[1000],
        toxic: toxicColors[500],
      },
      backgroundImage: {
        "gradient-radial": "radial-gradient(var(--tw-gradient-stops))",
        "gradient-background": `radial-gradient(${slate[800]} 0%,${midnightColors[1000]} 50%,  ${midnightColors[1000]} 100%)`,
        "gradient-secondary": `linear-gradient(90deg, ${blue[600]} 0%, ${purple[500]} 100%)`,
      },
    },
  },
};

/** @type {import('tailwindcss').Config} */
import { blue, red } from "tailwindcss/colors";

export const content = [
  // app content
  // "./src/**/*.{ts,jsx,tsx}",
  "./app/**/*.{ts,jsx,tsx}",
  // include packages if not transpiling
  "../../packages/**/*.{ts,tsx}",
];
export const theme = {
  extend: {
    fontFamily: {
      sans: ["Inter", "sans-serif"],
      mono: ["Roboto Mono", "monospace"],
    },
    colors: {
      brandblue: blue[500],
      brandred: red[500],
    },
  },
};
export const plugins = [
  require("@tailwindcss/forms"),
  require("@tailwindcss/typography"),
];

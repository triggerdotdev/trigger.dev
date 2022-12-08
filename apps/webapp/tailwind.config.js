/** @type {import('tailwindcss').Config} */
const parentConfig = require("@apihero/tailwind-config/tailwind.config");
const colors = require("tailwindcss/colors");
const midnightColors = {
  1000: "#030713",
};
const toxicColors = {
  500: "#41FF54",
};
module.exports = {
  ...parentConfig,
  theme: {
    ...parentConfig._theme,
    extend: {
      ...parentConfig.extend,
      colors: {
        midnight: midnightColors[1000],
        toxic: toxicColors[500],
      },
      backgroundImage: {
        "gradient-radial": "radial-gradient(var(--tw-gradient-stops))",
        "gradient-background": `radial-gradient(${colors.slate[800]} 0%,${midnightColors[1000]} 50%,  ${midnightColors[1000]} 100%)`,
        "gradient-secondary": `linear-gradient(90deg, ${colors.blue[600]} 0%, ${colors.purple[500]} 100%)`,
      },
    },
  },
};

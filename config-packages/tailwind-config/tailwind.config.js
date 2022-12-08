const colors = require("tailwindcss/colors");

module.exports = {
  content: [
    // app content
    // "./src/**/*.{ts,jsx,tsx}",
    "./app/**/*.{ts,jsx,tsx}",
    // include packages if not transpiling
    "../../packages/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Inter", "sans-serif"],
        mono: ["Roboto Mono", "monospace"],
      },
      colors: {
        brandblue: colors.blue[500],
        brandred: colors.red[500],
      },
    },
  },
  plugins: [require("@tailwindcss/forms"), require("@tailwindcss/typography")],
};

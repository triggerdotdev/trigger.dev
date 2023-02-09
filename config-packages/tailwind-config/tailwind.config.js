const colors = require("tailwindcss/colors");

const acidColors = {
  400: "#F1FF98",
  500: "#E7FF52",
  600: "#FFF067",
};

const toxicColors = { 
  400: "#8EFF9A", 
  500: "#41FF54", 
  600: "#00FFA3", 
};

module.exports = {
  content: [
    // app content
    // "./src/**/*.{ts,jsx,tsx}",
    "./app/**/*.{ts,jsx,tsx}",
    // include packages if not transpiling
    "../../packages/**/*.{ts,tsx}",
  ],
  theme: {
    colors: {
      acid: acidColors,
      toxic: toxicColors,
    },
    extend: {
      fontFamily: {
        sans: ["Inter", "sans-serif"],
        mono: ["Roboto Mono", "monospace"],
      },
      colors: {
        brandblue: colors.blue[500],
        brandred: colors.red[500],
        acid: acidColors,
        toxic: toxicColors,
      },
      backgroundImage: {
        "gradient-radial": "radial-gradient(var(--tw-gradient-stops))",
        "gradient-background": `radial-gradient(${colors.slate[800]} 0%,${midnightColors[1000]} 60%,  ${midnightColors[1000]} 100%)`,
        "gradient-background-2": `radial-gradient(${colors.violet[900]} 0%, ${midnightColors[1000]} 50%, ${midnightColors[1000]} 100%)`,
        "gradient-primary": `linear-gradient(90deg, ${acidColors[500]} 0%, ${toxicColors[500]} 100%)`,
        "gradient-primary-hover": `linear-gradient(80deg, ${acidColors[600]} 0%, ${toxicColors[600]} 100%)`,
        "gradient-secondary": `linear-gradient(90deg, ${colors.blue[600]} 0%, ${colors.purple[500]} 100%)`,
        "gradient-secondary-button": `linear-gradient(90deg, ${colors.blue[500]} 0%, ${colors.purple[500]} 100%)`,
        "gradient-secondary-hover": `linear-gradient(90deg, ${colors.blue[400]} 0%, ${colors.purple[400]} 100%)`,
        "gradient-tertiary": `linear-gradient(90deg, ${colors.pink[400]} 0%, ${colors.blue[300]} 100%) `,
      },
    },
  },
  
  plugins: [require("@tailwindcss/forms"), require("@tailwindcss/typography")],

};

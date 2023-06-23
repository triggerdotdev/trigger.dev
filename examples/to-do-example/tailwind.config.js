/** @type {import('tailwindcss').Config} */
const colors = require("tailwindcss/colors");

const slate = {
  ...colors.slate,
  450: "#7E8FA6",
  500: "#6B7C95",
  550: "#586981",
  600: "#45566D",
  650: "#3C4B62",
  750: "#293649",
  850: "#1A2434",
  900: "#131B2B",
};

/** Trigger.dev custom palette */
const midnight = {
  ...colors.slate,
  450: colors.slate[850],
  500: colors.slate[650],
  550: colors.slate[700],
  600: colors.slate[750],
  650: colors.slate[800],
  750: colors.slate[850],
  800: colors.slate[900],
  850: "#0E1521",
  900: "#0B1018",
};

/** Text colors */
const bright = colors.slate[200];
const dimmed = colors.slate[400];

module.exports = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      keyframes: {
        "accordion-down": {
          from: { height: 0 },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: 0 },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
      },
      fontFamily: {
        sans: ["Inter", "sans-serif"],
        mono: ["Roboto Mono", "monospace"],
      },
      fontSize: {
        xxs: [
          "0.65rem",
          {
            lineHeight: "0.75rem",
            letterSpacing: "-0.01em",
            fontWeight: "500",
          },
        ],
      },

      colors: {
        bright,
        dimmed,
        slate,
        acid: {
          400: "#F1FF98",
          500: "#E7FF52",
          600: "#FFF067",
        },
        toxic: {
          400: "#8EFF9A",
          500: "#41FF54",
          600: "#00FFA3",
        },
      },
    },
    backgroundImage: {
      "gradient-radial": "radial-gradient(var(--tw-gradient-stops))",
      "gradient-conic":
        "conic-gradient(from 180deg at 50% 50%, var(--tw-gradient-stops))",
      "gradient-primary": `linear-gradient(90deg, #E7FF52 0%, #41FF54 100%)`,
      "gradient-primary-hover": `linear-gradient(80deg, #FFF067 0%, #00FFA3 100%)`,
    },
  },
  plugins: [require("tailwindcss-animate")],
};

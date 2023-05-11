/** @type {import('tailwindcss').Config} */
const colors = require("tailwindcss/colors");

const background = "hsl(224 71% 4%)";
const foreground = "hsl(213 31% 91%)";

const muted = "hsl(223 47% 11%)";
const mutedForeground = "hsl(215.4 16.3% 56.9%)";

const popover = "hsl(224 71% 4%)";
const popoverForeground = "hsl(215 20.2% 65.1%)";

const card = "hsl(0 0% 100%)";
const cardForeground = "hsl(222.2 47.4% 11.2%)";

const border = "hsl(216 34% 17%)";
const input = "hsl(216 34% 17%)";

const primary = "hsl(210 40% 98%)";
const primaryForeground = "hsl(222.2 47.4% 1.2%)";

const secondary = "hsl(222.2 47.4% 11.2%)";
const secondaryForeground = "hsl(210 40% 98%)";

const accent = "hsl(216 34% 17%)";
const accentForeground = "hsl(210 40% 98%)";

const destructive = "hsl(0 63% 31%)";
const destructiveForeground = "hsl(210 40% 98%)";

const ring = "hsl(216 34% 17%)";

const radius = "0.5rem";

module.exports = {
  content: [
    "./app/**/*.{ts,jsx,tsx}",
    // include packages if not transpiling
    "../../packages/**/*.{ts,tsx}",
  ],
  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: {
        "2xl": "1400px",
      },
    },
    extend: {
      fontFamily: {
        sans: ["Inter", "sans-serif"],
        mono: ["Roboto Mono", "monospace"],
      },
      fontSize: {
        xxs: [
          "0.5rem",
          {
            lineHeight: "0.75rem",
            letterSpacing: "-0.01em",
            fontWeight: "500",
          },
        ],
      },
      colors: {
        border,
        input,
        ring,
        background,
        foreground,
        primary: {
          DEFAULT: primary,
          foreground: primaryForeground,
        },
        secondary: {
          DEFAULT: secondary,
          foreground: secondaryForeground,
        },
        destructive: {
          DEFAULT: destructive,
          foreground: destructiveForeground,
        },
        muted: {
          DEFAULT: muted,
          foreground: mutedForeground,
        },
        accent: {
          DEFAULT: accent,
          foreground: accentForeground,
        },
        popover: {
          DEFAULT: popover,
          foreground: popoverForeground,
        },
        card: {
          DEFAULT: card,
          foreground: cardForeground,
        },
        slate: {
          1000: "#060F1E",
          950: "#0A1423",
          850: "#141D2E",
        },
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
        devEnv: colors.pink,
        liveEnv: colors.green,
      },
      borderRadius: {
        lg: radius,
        md: `calc(${radius} - 2px)`,
        sm: `calc(${radius} - 4px)`,
      },
      keyframes: {
        "accordion-down": {
          from: { height: 0 },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: 0 },
        },
        float: {
          "0%": { transform: "translatey(0px)" },
          "50%": { transform: "translatey(7px)" },
          "100%": { transform: "translatey(0px)" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
      },
      backgroundImage: {
        "gradient-radial": "radial-gradient(var(--tw-gradient-stops))",
        "gradient-primary": `linear-gradient(90deg, acid-500 0%, toxic-500 100%)`,
        "gradient-primary-hover": `linear-gradient(80deg, acid-600 0%, toxic-600 100%)`,
      },
      gridTemplateColumns: {
        carousel: "repeat(6, 200px)",
      },
    },
  },
  plugins: [
    require("@tailwindcss/forms"),
    require("@tailwindcss/typography"),
    require("tailwindcss-animate"),
    require("tailwind-scrollbar"),
  ],
};

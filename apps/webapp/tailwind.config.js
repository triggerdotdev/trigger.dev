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
  950: "#0E1521",
  1000: "#0B1018",
};

const background = slate[1000];
const foreground = "hsl(213 31% 91%)";

const muted = "hsl(223 47% 11%)";
const mutedForeground = "hsl(215.4 16.3% 56.9%)";

const popover = slate[850];
const popoverForeground = colors.slate[800];

const card = "hsl(0 0% 100%)";
const cardForeground = "hsl(222.2 47.4% 11.2%)";

const border = slate[850];
const input = slate[850];

const primary = colors.indigo[600];
const primaryForeground = colors.indigo[500];

const secondary = "hsl(222.2 47.4% 11.2%)";
const secondaryForeground = slate[850];

const tertiary = "hsl(217 37% 7% / 0)";
const tertiaryForeground = slate[850];

const accent = slate[750];
const accentForeground = "hsl(210 40% 98%)";

const destructive = "hsl(0 63% 31%)";
const destructiveForeground = "hsl(210 40% 98%)";

const ring = slate[750];

const radius = "0.5rem";

const darkBackground = slate[1000];
const divide = slate[850];
const bright = colors.slate[200];
const dimmed = colors.slate[400];

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
          "0.65rem",
          {
            lineHeight: "0.75rem",
            letterSpacing: "-0.01em",
            fontWeight: "500",
          },
        ],
      },
      colors: {
        darkBackground,
        divide,
        bright,
        dimmed,
        background,
        border,
        input,
        ring,
        foreground,
        primary: {
          DEFAULT: primary,
          foreground: primaryForeground,
        },
        secondary: {
          DEFAULT: secondary,
          foreground: secondaryForeground,
        },
        tertiary: {
          DEFAULT: tertiary,
          foreground: tertiaryForeground,
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
        "gradient-secondary": `linear-gradient(90deg, hsl(271 91 65) 0%, hsl(221 83 53) 100%)`,
        "gradient-radial-secondary": `radial-gradient(hsl(271 91 65), hsl(221 83 53))`,
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

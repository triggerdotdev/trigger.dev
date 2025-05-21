/** @type {import('tailwindcss').Config} */
const colors = require("tailwindcss/colors");

// V2
const slate = {
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

const toxic = {
  50: "#E3FFE6",
  100: "#C8FFCD",
  200: "#A9FFAB",
  300: "#8AFF96",
  400: "#6DFC7B",
  500: "#41FF54",
  600: "#28F03C",
  700: "#2AE03C",
  800: "#22D834",
  900: "#16CC28",
};

const acid = {
  50: "#F9FFD1",
  100: "#F6FFB6",
  200: "#F3FF99",
  300: "#EEFF82",
  400: "#E7FF52",
  500: "#DAF437",
  600: "#C5E118",
  700: "#B2CD0A",
  800: "#A5BE07",
  900: "#9FB802",
};

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

// V3
const charcoal = {
  100: "#E8E9EC",
  200: "#D7D9DD",
  300: "#B5B8C0",
  400: "#878C99",
  500: "#5F6570",
  550: "#4D525B",
  600: "#3B3E45",
  650: "#2C3034",
  700: "#272A2E",
  750: "#212327",
  775: "#1C1E21",
  800: "#1A1B1F",
  850: "#15171A",
  900: "#121317",
  950: "#0D0E12",
  1000: "#0B0C0F",
};

const apple = {
  100: "#E4FFC9",
  200: "#CFFFA0",
  300: "#BFFF81",
  400: "#AFFF62",
  500: "#A8FF53",
  600: "#82D134",
  700: "#6FB12F",
  750: "#5E932A",
  800: "#45711A",
  850: "#2E4E10",
  900: "#20370A",
  950: "#152506",
};

const mint = {
  50: "#F0FDF4",
  100: "#DDFBE6",
  200: "#BDF5D0",
  300: "#87EBA9",
  400: "#4FD97E",
  500: "#28BF5C",
  600: "#1B9E48",
  700: "#197C3C",
  800: "#196233",
  900: "#16512C",
  950: "#062D15",
};

const sun = {
  50: "#FDFEE8",
  100: "#FDFFC2",
  200: "#FFFF89",
  300: "#FFF852",
  400: "#FDEA12",
  500: "#ECCF06",
  600: "#CCA302",
  700: "#A37505",
  800: "#865B0D",
  900: "#724B11",
  950: "#432705",
};

const lavender = {
  50: "##f4f2ff",
  100: "#eae8ff",
  200: "#d7d4ff",
  300: "#bab2ff",
  400: "#826dff",
  500: "#7655fd",
  600: "#6532f5",
  700: "#5620e1",
  800: "#481abd",
  900: "#3d189a",
  950: "#230c69",
};

/** Trigger.dev custom palette */

/** Text colors */
const primary = apple[500];
const secondary = charcoal[650];
const tertiary = charcoal[700];
const textLink = lavender[400];
const textDimmed = charcoal[400];
const textBright = charcoal[200];
const backgroundBright = charcoal[800];
const backgroundDimmed = charcoal[850];
const gridBright = charcoal[700];
const gridDimmed = charcoal[750];
const success = mint[500];
const pending = colors.blue[500];
const warning = colors.amber[500];
const error = colors.rose[600];
const devEnv = colors.pink[500];
const stagingEnv = colors.orange[400];
const previewEnv = colors.yellow[400];
const prodEnv = mint[500];

/** Icon colors */
const tasks = colors.blue[500];
const runs = colors.indigo[500];
const batches = colors.pink[500];
const schedules = colors.yellow[500];
const queues = colors.purple[500];
const deployments = colors.green[500];
const tests = colors.lime[500];
const apiKeys = colors.amber[500];
const environmentVariables = colors.pink[500];
const alerts = colors.red[500];
const projectSettings = colors.blue[500];
const orgSettings = colors.blue[500];
const docs = colors.blue[500];

/** Other variables */
const radius = "0.5rem";

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./app/**/*.{ts,jsx,tsx}"],
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
        sans: ["Geist Variable", "Helvetica Neue", "Helvetica", "Arial", "sans-serif"],
        mono: ["Geist Mono Variable", "monaco", "Consolas", "Lucida Console", "monospace"],
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
        "2sm": [
          "0.8125rem",
          {
            lineHeight: "0.875rem",
            letterSpacing: "-0.01em",
            fontWeight: "500",
          },
        ],
      },
      colors: {
        charcoal,
        apple,
        lavender,
        mint,
        sun,
        primary,
        secondary,
        tertiary,
        "text-link": textLink,
        "text-dimmed": textDimmed,
        "text-bright": textBright,
        "background-bright": backgroundBright,
        "background-dimmed": backgroundDimmed,
        "grid-bright": gridBright,
        "grid-dimmed": gridDimmed,
        success,
        pending,
        warning,
        error,
        dev: devEnv,
        staging: stagingEnv,
        prod: prodEnv,
        preview: previewEnv,
        tasks,
        runs,
        batches,
        schedules,
        queues,
        deployments,
        tests,
        apiKeys,
        environmentVariables,
        alerts,
        projectSettings,
        orgSettings,
        docs,
      },
      focusStyles: {
        outline: "1px solid",
        outlineOffset: "0px",
        outlineColor: textLink,
        borderRadius: "3px",
      },
      borderRadius: {
        lg: radius,
        md: `calc(${radius} - 2px)`,
        sm: `calc(${radius} - 4px)`,
      },
      boxShadow: {
        "glow-primary": "0 0 10px 5px rgba(218, 244, 55, 0.2)",
        "glow-secondary": "0 0 10px 5px rgba(79, 70, 229, 0.2)",
        "glow-pink": "0 0 10px 5px rgba(236, 72, 153, 0.2)",
      },
      outlineWidth: {
        3: "3px",
      },
      textShadow: {
        custom: "1px 1px 1px rgba(0, 0, 0, 0.5)", // Offset-X | Offset-Y | Blur radius | Color
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
        "tile-move": {
          "0%": { "background-position": "0px" },
          "100%": { "background-position": "8px" },
        },
        "tile-move-offset": {
          "0%": { "background-position": "-1px" },
          "100%": { "background-position": "7px" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        "tile-scroll": "tile-move 0.5s infinite linear",
        "tile-scroll-offset": "tile-move-offset 0.5s infinite linear",
      },
      backgroundImage: {
        "gradient-radial": "radial-gradient(closest-side, var(--tw-gradient-stops))",
        "gradient-primary": `linear-gradient(90deg, acid-500 0%, toxic-500 100%)`,
        "gradient-primary-hover": `linear-gradient(80deg, acid-600 0%, toxic-600 100%)`,
        "gradient-secondary": `linear-gradient(90deg, hsl(271 91 65) 0%, hsl(221 83 53) 100%)`,
        "gradient-radial-secondary ": `radial-gradient(hsl(271 91 65), hsl(221 83 53))`,
      },
      gridTemplateColumns: {
        carousel: "repeat(6, 200px)",
      },
      screens: {
        "lg-height": { raw: "(max-height: 750px)" },
        "md-height": { raw: "(max-height: 600px)" },
      },
      width: {
        0.75: "0.1875rem",
      },
      height: {
        0.75: "0.1875rem",
      },
    },
  },
  plugins: [
    require("@tailwindcss/container-queries"),
    require("@tailwindcss/forms"),
    require("@tailwindcss/typography"),
    require("tailwindcss-animate"),
    require("tailwind-scrollbar"),
    require("tailwind-scrollbar-hide"),
    require("tailwindcss-textshadow"),
    function ({ addUtilities, theme }) {
      const focusStyles = theme("focusStyles", {});
      addUtilities({
        ".focus-custom": {
          "&:focus-visible": focusStyles,
        },
      });
    },
  ],
};

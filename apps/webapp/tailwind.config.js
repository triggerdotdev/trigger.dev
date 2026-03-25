/** @type {import('tailwindcss').Config} */
const colors = require("tailwindcss/colors");

// V2 (legacy, kept for compatibility)
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

// V3 — charcoal kept for compatibility, but semantics are now light
const charcoal = {
  100: "#F8F9FA",
  200: "#F1F3F5",
  300: "#E9ECEF",
  400: "#868E96",
  500: "#495057",
  550: "#343A40",
  600: "#DEE2E6",
  650: "#E9ECEF",
  700: "#F1F3F5",
  750: "#F8F9FA",
  775: "#FAFBFC",
  800: "#FFFFFF",
  850: "#FFFFFF",
  900: "#FAFBFC",
  950: "#F8F9FA",
  1000: "#F1F3F5",
};

const apple = {
  100: "#F0FAF0",
  200: "#D1F0D1",
  300: "#A3E0A3",
  400: "#4CAF50",
  500: "#2E7D32",
  600: "#1B5E20",
  700: "#174F1C",
  750: "#134218",
  800: "#0E3513",
  850: "#0A280F",
  900: "#071C0A",
  950: "#041006",
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
  50: "#f4f2ff",
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

/** AirTrigger light theme palette */

/** Semantic color tokens — light mode */
const primary = "#2E7D32";
const secondary = "#F1F3F5";
const tertiary = "#F8F9FA";
const textLink = lavender[600];
const textDimmed = "#6B7280";
const textBright = "#111827";
const backgroundBright = "#FFFFFF";
const backgroundDimmed = "#F9FAFB";
const gridBright = "#E5E7EB";
const gridDimmed = "#F3F4F6";
const success = mint[600];
const pending = colors.blue[600];
const warning = colors.amber[600];
const error = colors.rose[600];
const devEnv = colors.pink[600];
const stagingEnv = colors.orange[500];
const previewEnv = colors.yellow[500];
const prodEnv = mint[600];

/** Icon colors */
const tasks = colors.blue[600];
const runs = colors.indigo[600];
const batches = colors.pink[600];
const schedules = colors.yellow[600];
const queues = colors.purple[600];
const query = colors.blue[600];
const metrics = colors.green[600];
const customDashboards = "#6B7280";
const deployments = colors.green[600];
const concurrency = colors.amber[600];
const limits = colors.purple[600];
const regions = colors.green[600];
const logs = colors.pink[600];
const tests = colors.lime[600];
const apiKeys = colors.amber[600];
const environmentVariables = colors.pink[600];
const alerts = colors.red[600];
const projectSettings = colors.blue[600];
const orgSettings = colors.blue[600];
const docs = colors.blue[600];
const bulkActions = colors.emerald[600];

/** Other variables */
const radius = "0.625rem";

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
        sans: ["Geist Variable", "Inter", "Helvetica Neue", "Helvetica", "Arial", "sans-serif"],
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
        concurrency,
        queues,
        query,
        regions,
        limits,
        deployments,
        logs,
        tests,
        apiKeys,
        environmentVariables,
        alerts,
        projectSettings,
        orgSettings,
        docs,
        bulkActions,
        metrics,
        customDashboards,
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
        "glow-primary": "0 0 10px 5px rgba(46, 125, 50, 0.1)",
        "glow-secondary": "0 0 10px 5px rgba(79, 70, 229, 0.1)",
        "glow-pink": "0 0 10px 5px rgba(236, 72, 153, 0.1)",
        sm: "0 1px 2px 0 rgb(0 0 0 / 0.03)",
        DEFAULT: "0 1px 3px 0 rgb(0 0 0 / 0.06), 0 1px 2px -1px rgb(0 0 0 / 0.06)",
        md: "0 4px 6px -1px rgb(0 0 0 / 0.06), 0 2px 4px -2px rgb(0 0 0 / 0.06)",
        lg: "0 10px 15px -3px rgb(0 0 0 / 0.06), 0 4px 6px -4px rgb(0 0 0 / 0.06)",
      },
      outlineWidth: {
        3: "3px",
      },
      textShadow: {
        custom: "none",
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
        "gradient-primary": `linear-gradient(90deg, #2E7D32 0%, #43A047 100%)`,
        "gradient-primary-hover": `linear-gradient(80deg, #1B5E20 0%, #2E7D32 100%)`,
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
        4.5: "1.125rem",
      },
      height: {
        0.75: "0.1875rem",
        4.5: "1.125rem",
      },
      size: {
        4.5: "1.125rem",
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

/** @type {import('tailwindcss').Config} */
const parentConfig = require("@trigger.dev/tailwind-config/tailwind.config");
const colors = require('tailwindcss/colors')

module.exports = {
  ...parentConfig,
  theme: {
    ...parentConfig.theme,
    
    extend: {
      ...parentConfig.extend,

      fontFamily: {
        sans: ["Inter", "sans-serif"],
        title: ["Poppins", "sans-serif"],
        mono: ["Roboto Mono", "monospace"],
      },
      colors: {
        'slate': {
          1000: '#060F1E',
          950: '#0A1423',
          850: '#141D2E',
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
      backgroundImage: {
        "gradient-radial": "radial-gradient(var(--tw-gradient-stops))",
        "gradient-primary": `linear-gradient(90deg, acid-500 0%, toxic-500 100%)`,
        "gradient-primary-hover": `linear-gradient(80deg, acid-600 0%, toxic-600 100%)`,
      },
      gridTemplateColumns: {
        'carousel': 'repeat(6, 200px)',
      },
      keyframes: {
        float: {
          '0%': { transform: 'translatey(0px)' },
          '50%': { transform: 'translatey(7px)' },
          '100%': { transform: 'translatey(0px)' },
        }
      }
    },
  },
  plugins: [
    require('tailwind-scrollbar-hide'), require("@tailwindcss/forms"), require("@tailwindcss/typography")
  ]
};
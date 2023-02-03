/** @type {import('tailwindcss').Config} */
const parentConfig = require("@trigger.dev/tailwind-config/tailwind.config");
const toxicColors = {
  500: "#41FF54",
};
module.exports = {
  ...parentConfig,
  theme: {
    ...parentConfig.theme,
    
    extend: {
      ...parentConfig.extend,
      colors: {
        'slate': {
          1000: '#060F1E',
          950: '#0A1423',
          850: '#141D2E',
        },
        toxic: toxicColors[500],
      },
      gridTemplateColumns: {
        'carousel': 'repeat(6, 200px)',
      }
    },
  },
  plugins: [
    require('tailwind-scrollbar-hide')
  ]
};

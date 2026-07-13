module.exports = {
  plugins: {
    "@tailwindcss/postcss": {
      // Always flatten nested selectors — the Remix compiler's esbuild can't parse CSS nesting.
      optimize: { minify: process.env.NODE_ENV === "production" },
    },
  },
};

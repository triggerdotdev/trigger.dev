/** @type {import('next').NextConfig} */

module.exports = {
  reactStrictMode: true,
  webpack: (config) => {
    // Add a loader for TypeScript files (this is only needed because we are pointing to @trigger.dev/sdk in the monorepo)
    config.module.rules.push({
      test: /\.tsx?$/,
      loader: "ts-loader",
      options: {
        transpileOnly: true,
        configFile: "tsconfig.json",
      },
    });

    return config;
  },
};

/** @type {import('next').NextConfig} */

module.exports = {
  reactStrictMode: true,
  transpilePackages: ["@trigger.dev/sdk", "@trigger.dev/github", "@trigger.dev/core"],
  experimental: {
    appDir: true,
  },
};

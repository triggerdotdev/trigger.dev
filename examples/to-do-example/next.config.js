/** @type {import('next').NextConfig} */
const nextConfig = {};

module.exports = {
  reactStrictMode: true,
  transpilePackages: [
    "@trigger.dev/sdk",
    "@trigger.dev/github",
    "@trigger.dev/internal",
  ],
  experimental: {
    appDir: true,
  },
};

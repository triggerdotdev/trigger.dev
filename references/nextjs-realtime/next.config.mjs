/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "utfs.io",
        pathname: "/a/ze1ekrd9t9/*",
      },
      {
        protocol: "https",
        hostname: "v2.fal.media",
      },
      {
        protocol: "https",
        hostname: "v3.fal.media",
      },
      {
        protocol: "https",
        hostname: "fal.media",
      },
      {
        protocol: "https",
        hostname: "storage.googleapis.com",
      },
    ],
  },
};

export default nextConfig;

/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["three"],
  async redirects() {
    return [{ source: "/compare", destination: "/#compare", permanent: true }];
  },
  async rewrites() {
    return [{ source: "/favicon.ico", destination: "/icon.svg" }];
  },
};

export default nextConfig;

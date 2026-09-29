/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["three"],
  async rewrites() {
    return [{ source: "/favicon.ico", destination: "/icon.svg" }];
  },
};

export default nextConfig;

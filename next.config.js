/** @type {import('next').NextConfig} */
const nextConfig = {
  allowedDevOrigins: ["127.0.0.1"],
  reactStrictMode: true,
  experimental: {
    lockDistDir: false,
  },
};

export default nextConfig;

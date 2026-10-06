/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: [
    "@elettro/auth",
    "@elettro/database",
    "@elettro/ai",
    "@elettro/connectors"
  ]
};

export default nextConfig;

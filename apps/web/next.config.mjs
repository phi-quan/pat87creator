/** @type {import('next').NextConfig} */
const nextConfig = {
  webpack: (config, { dev }) => {
    // Cloudflare Pages has a 25 MiB per-file upload limit.
    // Disable persistent webpack caching in production so .next/cache/webpack/*.pack
    // artifacts are not generated and included in deployment output.
    if (!dev) {
      config.cache = false;
    }

    return config;
  },
};

export default nextConfig;

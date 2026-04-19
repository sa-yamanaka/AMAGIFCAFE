/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // LIFFは外部iframeから開かれるのでCSP/ヘッダは必要に応じて調整する
};

module.exports = nextConfig;

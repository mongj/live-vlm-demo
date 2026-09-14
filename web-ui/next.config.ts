import type { NextConfig } from "next";

const gatewayUrl = (process.env.VLM_GATEWAY_URL ?? "http://127.0.0.1:8787").replace(
  /\/$/,
  ""
);

const nextConfig: NextConfig = {
  reactCompiler: true,
  async rewrites() {
    return [
      {
        source: "/v1/:path*",
        destination: `${gatewayUrl}/v1/:path*`,
      },
    ];
  },
};

export default nextConfig;

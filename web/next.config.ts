import type { NextConfig } from "next";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

const nextConfig: NextConfig = {
  // Let phones on the LAN load dev assets (Next blocks non-localhost origins in dev).
  allowedDevOrigins: ["192.168.*.*"],
  // No cacheComponents: its render hangs on the Workers runtime (Next relies on a patched setTimeout).
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;

// Exposes wrangler bindings to `next dev`. D1 is marked `remote` in wrangler.jsonc,
// so dev reads and writes the real Cloudflare database.
initOpenNextCloudflareForDev();

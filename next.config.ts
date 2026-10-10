import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(self), geolocation=()" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // PGlite (in-process Postgres used only when DATABASE_URL is unset) ships WASM and must not be bundled.
  serverExternalPackages: ["@electric-sql/pglite", "pg"],
  // Business knowledge files are read from disk at runtime by the knowledge layer.
  outputFileTracingIncludes: {
    "/**": ["./content/knowledge/**/*", "./drizzle/**/*"],
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;

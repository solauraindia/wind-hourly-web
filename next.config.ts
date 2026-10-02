import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // exceljs is CommonJS with optional deps; load it from node_modules at runtime
  serverExternalPackages: ["exceljs"],
};

export default nextConfig;

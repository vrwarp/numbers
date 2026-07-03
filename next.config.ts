import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // sharp and @prisma/client contain native binaries that must not be bundled
  serverExternalPackages: ["sharp", "@prisma/client"],
};

export default nextConfig;

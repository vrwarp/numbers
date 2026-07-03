import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // sharp and @prisma/client contain native binaries that must not be bundled;
  // firebase-admin resolves internal modules at runtime and breaks if inlined
  serverExternalPackages: ["sharp", "@prisma/client", "firebase-admin"],
};

export default nextConfig;

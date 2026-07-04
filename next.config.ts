import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // sharp and @prisma/client contain native binaries that must not be bundled;
  // firebase-admin resolves internal modules at runtime and breaks if inlined;
  // pdfjs-dist loads its native canvas backend (@napi-rs/canvas) at runtime
  serverExternalPackages: [
    "sharp",
    "@prisma/client",
    "firebase-admin",
    "pdfjs-dist",
    "@napi-rs/canvas",
  ],
};

export default nextConfig;

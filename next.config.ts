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
  // pdfjs rasterizes via runtime requires the standalone tracer can't follow —
  // its native canvas backend (@napi-rs/canvas *.node) and its worker/font/cmap
  // assets get dropped from the Docker image, so the PDF /preview route 500s.
  // Force the whole of both packages into the route's file trace.
  outputFileTracingIncludes: {
    "/api/receipts/[id]/preview": [
      "./node_modules/@napi-rs/**/*",
      "./node_modules/pdfjs-dist/**/*",
    ],
  },
};

export default nextConfig;

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  distDir: process.env.NEXT_DIST_DIR || ".next",
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
    // The client-side signing surface fetches the pdf.js worker from this
    // route, which reads it out of node_modules at runtime.
    "/api/esign/pdf-worker": ["./node_modules/pdfjs-dist/build/*"],
  },
  // Firebase's sign-in helper lives under /__/auth (and /__/firebase) on the
  // authDomain. App Router treats "__"-prefixed folders as private (unroutable),
  // so map those paths onto the /fbauth reverse-proxy route instead. Dormant
  // unless FIREBASE_AUTH_PROXY points the client authDomain at our own origin.
  async rewrites() {
    return [
      { source: "/__/auth/:path*", destination: "/fbauth/auth/:path*" },
      { source: "/__/firebase/:path*", destination: "/fbauth/firebase/:path*" },
    ];
  },
};

export default nextConfig;

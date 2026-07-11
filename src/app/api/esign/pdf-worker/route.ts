import fs from "fs";
import path from "path";

export const runtime = "nodejs";

/**
 * Serves the pdf.js worker script from node_modules on our own origin, so the
 * click-to-stamp signing surface (docs/ESIGN_DESIGN.md click-to-stamp) can
 * render PDFs client-side without a CDN and without fighting the bundler's
 * handling of pdfjs-dist as a server-external ESM package. Immutable + cached.
 *
 * The path is assembled at runtime (not a static require.resolve) so webpack
 * doesn't try to bundle the ESM worker; next.config's outputFileTracingIncludes
 * copies the file into the standalone build.
 */
let cached: string | null = null;

function workerPath(): string {
  const candidates = [
    path.join(process.cwd(), "node_modules", "pdfjs-dist", "build", "pdf.worker.min.mjs"),
    // Standalone builds nest the app under its trace root.
    path.join(process.cwd(), ".next", "standalone", "node_modules", "pdfjs-dist", "build", "pdf.worker.min.mjs"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return candidates[0];
}

// pdf.js v6 calls the TC39 Map/WeakMap getOrInsert(Computed) proposal, absent
// in shipping browsers — the worker runs in its own realm, so it needs the
// polyfill prepended here (the main-thread one can't reach it).
const POLYFILL =
  "(function(){function p(o){if(typeof o.getOrInsert!=='function'){o.getOrInsert=function(k,v){if(!this.has(k))this.set(k,v);return this.get(k)}}" +
  "if(typeof o.getOrInsertComputed!=='function'){o.getOrInsertComputed=function(k,f){if(!this.has(k))this.set(k,f(k));return this.get(k)}}}" +
  "p(Map.prototype);p(WeakMap.prototype);})();\n";

export async function GET() {
  if (cached === null) {
    cached = POLYFILL + fs.readFileSync(workerPath(), "utf8");
  }
  return new Response(cached, {
    headers: {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}

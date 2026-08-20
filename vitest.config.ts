import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  test: {
    environment: "node",
    // unit/ is pure (no db); integration/ runs on a real throwaway SQLite db
    // per file (tests/integration/db.ts) — still self-contained and parallel.
    include: ["tests/unit/**/*.test.ts", "tests/integration/**/*.test.ts"],
    coverage: {
      provider: "v8",
      // Only what these suites can meaningfully reach: server/shared library
      // code. Route handlers, React components and the e-sign browser
      // ceremonies are covered by the Playwright suites instead (see
      // docs/agent/TESTING.md), so counting them here would just report a
      // misleading number.
      include: ["src/lib/**", "src/i18n/**", "src/auth.ts"],
      exclude: ["**/*.d.ts", "src/lib/**/types.ts"],
      reporter: ["text", "json-summary"],
    },
  },
});

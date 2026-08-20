import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Real-SQLite harness for the integration suite (tests/integration/**): each
 * test FILE gets its own database file and DATA_DIR so files run in parallel
 * without sharing state. The schema is applied once per schema.prisma content
 * (a template db keyed by schema hash, cached under the OS tmpdir) and then
 * copied per file — `prisma db push` costs seconds, the copy is instant.
 *
 * MUST be called before importing any module that pulls in `@/lib/prisma`
 * (the client captures DATABASE_URL at first import), so test files use
 * `await import(...)` for the code under test.
 */
export function freshTestDb(tag: string): { dir: string; dbPath: string } {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const schemaPath = path.join(repoRoot, "prisma", "schema.prisma");
  const schemaHash = createHash("sha256")
    .update(fs.readFileSync(schemaPath))
    .digest("hex")
    .slice(0, 16);

  const template = path.join(os.tmpdir(), `numbers-test-template-${schemaHash}.db`);
  if (!fs.existsSync(template)) {
    const staging = `${template}.${process.pid}.${Math.random().toString(36).slice(2)}`;
    execFileSync("npx", ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"], {
      cwd: repoRoot,
      env: { ...process.env, DATABASE_URL: `file:${staging}` },
      stdio: "pipe",
    });
    // Atomic-ish publish: concurrent workers may race here; last rename wins
    // and every winner is an identical schema-applied file.
    fs.renameSync(staging, template);
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `numbers-${tag}-`));
  const dbPath = path.join(dir, "test.db");
  fs.copyFileSync(template, dbPath);

  process.env.DATABASE_URL = `file:${dbPath}`;
  process.env.DATA_DIR = dir;
  return { dir, dbPath };
}

/** Best-effort cleanup for afterAll. */
export function removeTestDb(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

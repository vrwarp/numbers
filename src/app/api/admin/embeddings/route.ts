import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleApi, ApiError } from "@/lib/api";
import { requireAdmin } from "@/lib/admin/guard";
import { prisma } from "@/lib/prisma";
import {
  embeddingSettings,
  invalidateEmbeddingSettingsCache,
  DEFAULT_QUERY_PREFIX,
} from "@/lib/embeddings/settings";
import { probeEndpoint, EmbedError } from "@/lib/embeddings/provider";
import { sha256Hex } from "@/lib/embeddings/content";
import { kickSweep } from "@/lib/embeddings/worker";
import { invalidateIndexCache } from "@/lib/embeddings/index-cache";
import { isEmbeddingMock } from "@/lib/embeddings/settings-shared";
import { configValue } from "@/lib/config-file";

export const runtime = "nodejs";

/**
 * Admin search-index settings + health (docs/SEARCH_DESIGN.md §10, §3.2-3.3).
 * The GET NEVER returns the API key — fingerprint + set flag only; a PUT with
 * the key absent/empty preserves the stored one. Model/dim changes wipe and
 * rebuild the index (one transaction + synchronous sweep kick).
 */

function keyFingerprint(key: string): string {
  if (!key) return "";
  return `${sha256Hex(key).slice(0, 8)}…${key.slice(-4)}`;
}

async function queueHealth() {
  const [byStatus, oldest, indexed, perItem] = await Promise.all([
    prisma.embeddingJob.groupBy({ by: ["status"], _count: true }),
    prisma.embeddingJob.findFirst({
      where: { status: "queued" },
      orderBy: { createdAt: "asc" },
      select: { createdAt: true },
    }),
    prisma.embedding.count(),
    prisma.extractionLog.aggregate({
      where: { kind: "embedding", status: "success", prompt: { not: "query" } },
      _avg: { durationMs: true },
      _count: true,
    }),
  ]);
  const counts = Object.fromEntries(byStatus.map((s) => [s.status, s._count]));
  const rebuildPending = await prisma.embeddingJob.count({
    where: { priority: 1, status: { in: ["queued", "running"] } },
  });
  return {
    queued: counts.queued ?? 0,
    running: counts.running ?? 0,
    failed: counts.failed ?? 0,
    done: counts.done ?? 0,
    indexed,
    rebuildPending,
    oldestQueuedAt: oldest?.createdAt.toISOString() ?? null,
    avgItemMs: Math.round(perItem._avg.durationMs ?? 15000),
  };
}

export async function GET() {
  return handleApi(async () => {
    await requireAdmin();
    const s = await embeddingSettings();
    const failedJobs = await prisma.embeddingJob.findMany({
      where: { status: "failed" },
      orderBy: { updatedAt: "desc" },
      take: 50,
      select: { id: true, kind: true, targetId: true, lastError: true, updatedAt: true },
    });
    return NextResponse.json({
      configured: !!s,
      settings: s
        ? {
            enabled: s.enabled,
            endpoint: s.endpoint,
            model: s.model,
            dim: s.dim,
            queryPrefix: s.queryPrefix,
            minScore: s.minScoreMilli / 1000,
            apiKeySet: !!s.apiKey,
            apiKeyFingerprint: keyFingerprint(s.apiKey),
          }
        : null,
      // Env/DB divergence hint (§3.2): after the seed, env edits no longer apply.
      envDiffers:
        !!s && !!configValue("EMBEDDING_ENDPOINT") &&
        configValue("EMBEDDING_ENDPOINT") !== s.endpoint,
      queue: await queueHealth(),
      failedJobs,
      defaultQueryPrefix: DEFAULT_QUERY_PREFIX,
    });
  });
}

const PutSchema = z.object({
  enabled: z.boolean().optional(),
  endpoint: z.string().max(300).optional(),
  apiKey: z.string().max(300).optional(), // absent/empty = keep stored
  model: z.string().max(100).optional(),
  queryPrefix: z.string().max(300).optional(),
  minScore: z.number().min(0).max(1).optional(),
  skipProbe: z.boolean().optional(), // audited escape (endpoint down, admin knows)
  dim: z.number().int().min(1).max(16384).optional(), // only honored with skipProbe
});

export async function PUT(req: NextRequest) {
  return handleApi(async () => {
    const adminId = await requireAdmin();
    const parsed = PutSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new ApiError(400, "Invalid settings");
    const body = parsed.data;
    const current = await embeddingSettings();

    const next = {
      enabled: body.enabled ?? current?.enabled ?? false,
      endpoint: (body.endpoint ?? current?.endpoint ?? "").trim(),
      apiKey: body.apiKey?.trim() ? body.apiKey.trim() : (current?.apiKey ?? ""),
      model: (body.model ?? current?.model ?? "").trim() || "qwen3-vl-embedding-2b",
      queryPrefix: body.queryPrefix ?? current?.queryPrefix ?? DEFAULT_QUERY_PREFIX,
      minScoreMilli: body.minScore !== undefined
        ? Math.round(body.minScore * 1000)
        : (current?.minScoreMilli ?? 250),
      dim: current?.dim ?? 0,
    };
    if (!next.endpoint && !isEmbeddingMock()) {
      throw new ApiError(400, "Endpoint is required");
    }

    // Probe policy (§3.2): probe only when the save makes us DO MORE — enabling,
    // or changing endpoint/model/key while enabled. Detects dim (admins never
    // type 2048). Never probes a disable or a prefix/threshold edit.
    const identityChanged =
      next.endpoint !== (current?.endpoint ?? "") ||
      next.model !== (current?.model ?? "") ||
      next.apiKey !== (current?.apiKey ?? "");
    const enabling = next.enabled && !(current?.enabled ?? false);
    const needsProbe = next.enabled && (enabling || identityChanged);
    let probedMs: number | null = null;
    if (needsProbe && !body.skipProbe) {
      try {
        const probe = await probeEndpoint(next);
        next.dim = probe.dim;
        probedMs = probe.ms;
      } catch (err) {
        throw new ApiError(
          502,
          err instanceof EmbedError ? err.message : "Connection test failed",
          "embeddingProbeFailed"
        );
      }
    } else if (body.skipProbe && body.dim) {
      next.dim = body.dim;
    }

    const modelChanged = !!current && (next.model !== current.model || next.dim !== current.dim);
    const row = current
      ? await prisma.embeddingSettings.update({ where: { id: current.id }, data: next })
      : await prisma.embeddingSettings.create({ data: next });
    invalidateEmbeddingSettingsCache();

    if (modelChanged) {
      // §3.3: model/dim identity change = wipe + rebuild.
      await prisma.$transaction([
        prisma.embedding.deleteMany({}),
        prisma.embeddingJob.deleteMany({}),
      ]);
      invalidateIndexCache();
      await kickSweep();
    }

    // Audited, key redacted to a fingerprint (§3.2).
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const field of ["enabled", "endpoint", "model", "dim", "queryPrefix", "minScoreMilli"] as const) {
      const from = current?.[field];
      const to = next[field];
      if (from !== to) changes[field] = { from: from ?? null, to };
    }
    if ((current?.apiKey ?? "") !== next.apiKey) {
      changes.apiKey = {
        from: keyFingerprint(current?.apiKey ?? ""),
        to: keyFingerprint(next.apiKey),
      };
    }
    await prisma.auditEvent.create({
      data: {
        userId: adminId,
        action: "update-embedding-config",
        detail: JSON.stringify({
          changes,
          probeSkipped: !!body.skipProbe && needsProbe,
          rebuildStarted: modelChanged,
        }),
      },
    });

    return NextResponse.json({
      ok: true,
      dim: row.dim,
      probedMs,
      rebuildStarted: modelChanged,
    });
  });
}

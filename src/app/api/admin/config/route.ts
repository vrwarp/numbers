import { NextResponse } from "next/server";
import { handleApi, ApiError } from "@/lib/api";
import { requireAdmin } from "@/lib/admin/guard";
import { prisma } from "@/lib/prisma";
import {
  configValue,
  configFileHas,
  configFilePathPublic,
  writeConfigValues,
} from "@/lib/config-file";
import {
  ADMIN_CONFIG_FIELDS,
  adminConfigField,
  normalizeConfigValue,
} from "@/lib/admin/config-schema";

export const runtime = "nodejs";

/**
 * Allowlisted deployment settings editor (docs/ADMIN.md "Guard-rails"). Only
 * ADMIN_CONFIG_FIELDS keys are readable/writable; secrets are write-only (the
 * client learns whether one is `set`, never its value). Writes merge into
 * <DATA_DIR>/config.json (hot-reloaded). Admin-gated + audited (redacted diff).
 */

export async function GET() {
  return handleApi(async () => {
    await requireAdmin();
    const fields = ADMIN_CONFIG_FIELDS.map((f) => {
      const effective = configValue(f.key);
      return {
        key: f.key,
        group: f.group,
        type: f.type,
        secret: !!f.secret,
        options: f.options ?? null,
        onValue: f.onValue ?? null,
        min: f.min ?? null,
        max: f.max ?? null,
        placeholder: f.placeholder ?? null,
        fromFile: configFileHas(f.key),
        set: !!effective?.trim(),
        // Secrets are never echoed; booleans report on/off; text/number/select
        // return their current value for editing.
        value: f.secret ? "" : (effective ?? ""),
      };
    });
    return NextResponse.json({ filePath: configFilePathPublic(), fields });
  });
}

export async function PATCH(req: Request) {
  return handleApi(async () => {
    const adminId = await requireAdmin();
    const body = (await req.json().catch(() => ({}))) as {
      values?: Record<string, unknown>;
      clear?: unknown;
    };
    const values = body.values && typeof body.values === "object" ? body.values : {};
    const clear = Array.isArray(body.clear) ? body.clear.filter((k): k is string => typeof k === "string") : [];

    const updates: Record<string, string | null> = {};
    const changed: { key: string; op: "set" | "clear"; secret: boolean }[] = [];

    for (const [key, raw] of Object.entries(values)) {
      const field = adminConfigField(key);
      if (!field) throw new ApiError(400, `${key} is not an editable setting`, "admin.unknownField");
      // Empty secret means "leave the stored value unchanged".
      if (field.secret && typeof raw === "string" && raw.trim() === "") continue;
      const normalized = normalizeConfigValue(field, raw);
      updates[key] = normalized;
      changed.push({ key, op: normalized === null ? "clear" : "set", secret: !!field.secret });
    }
    for (const key of clear) {
      const field = adminConfigField(key);
      if (!field) throw new ApiError(400, `${key} is not an editable setting`, "admin.unknownField");
      updates[key] = null;
      changed.push({ key, op: "clear", secret: !!field.secret });
    }

    if (changed.length === 0) throw new ApiError(400, "Nothing to change", "admin.nothingToChange");

    writeConfigValues(updates);
    await prisma.auditEvent.create({
      data: {
        userId: adminId,
        action: "admin-config",
        // Redacted: keys + whether set/cleared, never secret values.
        detail: JSON.stringify({
          changed: changed.map((c) => ({
            key: c.key,
            op: c.op,
            ...(c.secret || c.op === "clear" ? {} : { value: updates[c.key] }),
          })),
        }),
      },
    });
    return NextResponse.json({ ok: true, changed: changed.map((c) => c.key) });
  });
}

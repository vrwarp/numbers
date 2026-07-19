"use client";

import { useLocale, useTranslations } from "next-intl";
import { builtinPositionKey, customPositionName, type PositionNameSet } from "@/lib/positions";

/**
 * The single localization boundary for Position (custom approval role) names.
 * Apply it at EVERY site that shows a position name (editor, budget-category
 * picker, members directory, approver picker) so localization stays uniform.
 *
 * A built-in default (its English `name` matches the roster) renders from the
 * shared `Positions.builtin.<key>` catalog. A custom, treasurer-authored
 * position renders from its own per-locale name (`nameZhHans`/`nameZhHant`),
 * falling back to the English `name`. Resolution is client-side (`useLocale`)
 * so a language switch re-labels without refetching.
 *
 * Accepts either a full name set or a bare string (a bare string is treated as
 * the English name with no custom translations).
 */
export function usePositionLabel(): (
  name: PositionNameSet | string | null | undefined
) => string {
  const t = useTranslations("Positions.builtin");
  const locale = useLocale();
  return (name) => {
    if (!name) return "";
    const set: PositionNameSet =
      typeof name === "string" ? { name, nameZhHans: null, nameZhHant: null } : name;
    const key = builtinPositionKey(set.name);
    return key ? t(key) : customPositionName(set, locale);
  };
}

"use client";

import { useTranslations } from "next-intl";
import { builtinPositionKey } from "@/lib/positions";

/**
 * The single localization boundary for Position (custom approval role) names.
 * Positions are stored as canonical English strings; the ten built-in defaults
 * additionally carry localized names under `Positions.builtin.<key>`. This hook
 * returns a labeler that renders a built-in in the active locale and any
 * treasurer-authored custom position verbatim — apply it at EVERY site that
 * shows a position name (editor, budget-category picker, members directory,
 * approver picker) so localization stays uniform and single-sourced.
 */
export function usePositionLabel(): (name: string | null | undefined) => string {
  const t = useTranslations("Positions.builtin");
  return (name) => {
    if (!name) return "";
    const key = builtinPositionKey(name);
    return key ? t(key) : name;
  };
}

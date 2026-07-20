import { createTranslator, type AbstractIntlMessages } from "next-intl";
import en from "../../../messages/en.json";
import zhHans from "../../../messages/zh-Hans.json";
import zhHant from "../../../messages/zh-Hant.json";
import type { Locale } from "@/lib/locales";
import type { NotificationKind, NotificationParams } from "./catalog";
import { KIND_SPECS } from "./catalog";

/**
 * Server-side push text composition (docs/NOTIFICATIONS_DESIGN.md §9/§9.1):
 * localized per token locale at SEND time from event params — never stored.
 * The client activity list renders the same catalog keys through
 * useTranslations at render time; keep the key contract in sync.
 *
 * Composition rules (§9.1): action verb first, the optional label last (so
 * tray truncation eats the label, never the verb); empty label falls back to
 * the "bare" complete-sentence variant — NEVER a dangling separator, and
 * NEVER claimDescription as a fallback (it names people and pastoral
 * situations).
 */

// Loose typing on purpose: the zh catalogs match en KEY-wise (test-enforced
// by tests/unit/messages.test.ts), but their inferred JSON types differ.
const CATALOGS: Record<Locale, AbstractIntlMessages> = {
  en: en as unknown as AbstractIntlMessages,
  "zh-Hans": zhHans as unknown as AbstractIntlMessages,
  "zh-Hant": zhHant as unknown as AbstractIntlMessages,
};

export type ComposedPush = { title: string; body: string };

function translator(locale: Locale) {
  const messages = CATALOGS[locale] ?? CATALOGS.en;
  // Dynamic keys against loosely-typed catalogs (the use-api-error pattern) —
  // key existence is enforced by the §9.1 composition test, not the compiler.
  return createTranslator({ locale, messages, namespace: "Notifications.push" }) as unknown as (
    key: string,
    values?: Record<string, string | number>
  ) => string;
}

/** Compose the localized push text for one kind. `count` only affects
 *  finance-queue (per-recipient coalescing, §5). `discreet` rewrites
 *  claim-lifecycle kinds to outcome- and name-neutral text (§8.2). */
export function composePush(
  kind: NotificationKind,
  params: NotificationParams,
  opts: { locale: Locale; discreet?: boolean; count?: number }
): ComposedPush {
  const t = translator(opts.locale);
  const label = params.label?.trim() ?? "";
  const name = params.name?.trim() ?? "";

  if (opts.discreet && KIND_SPECS[kind].discreetable) {
    const key =
      kind === "signing-request"
        ? "discreet.signing"
        : kind === "finance-queue"
          ? "discreet.finance"
          : "discreet.claims";
    return { title: t(key), body: t("discreet.body") };
  }

  switch (kind) {
    case "signing-request":
      return {
        title: label ? t("signingRequest.title", { label }) : t("signingRequest.titleBare"),
        body: name ? t("signingRequest.body", { name }) : t("signingRequest.bodyBare"),
      };
    case "claim-approved":
      return {
        title: label ? t("claimApproved.title", { label }) : t("claimApproved.titleBare"),
        body: "",
      };
    case "claim-rejected":
      return {
        title: label ? t("claimRejected.title", { label }) : t("claimRejected.titleBare"),
        body: t("claimRejected.body"),
      };
    case "finance-queue": {
      const count = Math.max(1, opts.count ?? 1);
      return {
        title: t("financeQueue.title", { count }),
        body: count === 1 && label ? t("financeQueue.bodySingle", { label }) : "",
      };
    }
    case "claim-paid":
      return {
        title: label ? t("claimPaid.title", { label }) : t("claimPaid.titleBare"),
        body: "",
      };
    case "device-request":
      return { title: t("deviceRequest.title"), body: t("deviceRequest.body") };
    case "self-test":
      return { title: t("selfTest.title"), body: t("selfTest.body") };
  }
}

"use client";

/**
 * Treasurer queue + mark-paid ceremony (docs/ESIGN_DESIGN.md §6.1–6.2,
 * decision 9): approved claims awaiting payment, each re-verified
 * client-side before the payment signature is possible; paid history with
 * certificate links.
 */

import { useCallback, useEffect, useState } from "react";
import { useOpenParam } from "@/lib/use-open-param";
import { useAutoRefresh } from "@/lib/use-auto-refresh";
import { useTranslations } from "next-intl";
import { runPaidCeremony } from "@/lib/esign/client";
import { useApiErrorMessage, useThrownErrorMessage } from "@/lib/use-api-error";
import { AuditDetails, ChainAlert, PacketLink, ThreadSignatures, useClaimChain } from "./chain";
import { SigningConnectCard } from "./SigningConnect";
import { type InboxClaim } from "./ApprovalsInbox";
import ClaimSummaryRow from "./ClaimSummaryRow";
import PdfLink from "@/components/PdfLink";
import { deliverPdf, downloadBlob, isStandalonePwa, pdfFile, sharePdf } from "@/lib/pdf-delivery";

export default function FinanceQueue() {
  const t = useTranslations("Finance");
  const tEsign = useTranslations("Esign");
  const tCommon = useTranslations("Common");
  const apiError = useApiErrorMessage();
  // null = first load still in flight — don't flash the empty state.
  const [claims, setClaims] = useState<InboxClaim[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  // Batch-print selection over the paid section (docs: treasurer prints many
  // filed packets at once). Both toggles default OFF — the lean output is just
  // the CFCC forms; receipts and the signature certificate are opt-in. The two
  // toggles are persisted per-user (profile row) so the choice follows the
  // account across devices; we seed them from /api/profile on mount.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [includeReceipts, setIncludeReceipts] = useState(false);
  const [includeCertificate, setIncludeCertificate] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [printError, setPrintError] = useState<string | null>(null);
  // Built batch waiting for a fresh-gesture share (standalone PWA only).
  const [printReady, setPrintReady] = useState<{ blob: Blob; filename: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/profile")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data?.user) return;
        setIncludeReceipts(!!data.user.printIncludeReceipts);
        setIncludeCertificate(!!data.user.printIncludeCertificate);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Persist a toggle change (fire-and-forget: a failed save just means the
  // preference doesn't stick, never a blocked print).
  const savePrintPref = useCallback((patch: Record<string, boolean>) => {
    void fetch("/api/profile", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }).catch(() => {});
  }, []);
  // ?open=<id> deep link from search results (shared contract).
  const list = claims ?? [];
  useOpenParam({
    ready: list.length > 0,
    exists: (id) => list.some((c) => c.id === id),
    beforeScroll: (id) => {
      if (list.find((c) => c.id === id)?.status === "approved") setOpenId(id);
    },
  });
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/finance");
    if (!res.ok) {
      setError(apiError(await res.json().catch(() => null), tEsign("loadFailed")));
      return;
    }
    const next: InboxClaim[] = (await res.json()).claims ?? [];
    setClaims(next);
    // Drop any selection whose row no longer exists after a reload.
    setSelected((prev) => {
      const paidIds = new Set(next.filter((c) => c.status === "paid").map((c) => c.id));
      const kept = new Set([...prev].filter((id) => paidIds.has(id)));
      return kept.size === prev.size ? prev : kept;
    });
  }, [apiError, tEsign]);
  useEffect(() => {
    void load();
  }, [load]);
  // Newly approved claims should appear without a manual reload — but never
  // refresh under an open paid ceremony or while a print is being built.
  useAutoRefresh(load, { paused: openId !== null || printing });

  const queue = list.filter((c) => c.status === "approved");
  const paid = list.filter((c) => c.status === "paid");

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  async function printSelected() {
    const ids = paid.filter((c) => selected.has(c.id)).map((c) => c.id);
    if (ids.length === 0) return;
    setPrinting(true);
    setPrintError(null);
    // Open the tab inside the click gesture so the pop-up isn't blocked; point
    // it at the built PDF, or close it (and fall back to a download) on failure.
    // Standalone PWA: no tab at all — blob tabs fail there and the overlay
    // browser has no session cookie; the share sheet is the print/save path.
    const standalone = isStandalonePwa();
    const win = standalone ? null : window.open("", "_blank");
    try {
      const res = await fetch("/api/finance/print", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids, includeReceipts, includeCertificate }),
      });
      if (!res.ok) {
        throw new Error(apiError(await res.json().catch(() => null), t("printFailed")));
      }
      const blob = await res.blob();
      if (standalone) {
        if (!(await deliverPdf(blob, "cfcc-packets.pdf"))) {
          setPrintReady({ blob, filename: "cfcc-packets.pdf" });
        }
        return;
      }
      const url = URL.createObjectURL(blob);
      if (win) win.location.href = url;
      else {
        const a = document.createElement("a");
        a.href = url;
        a.download = "cfcc-packets.pdf";
        document.body.appendChild(a);
        a.click();
        a.remove();
      }
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      win?.close();
      setPrintError(e instanceof Error ? e.message : t("printFailed"));
    } finally {
      setPrinting(false);
    }
  }

  return (
    <div className="space-y-6 pb-24">
      <div>
        <h1 className="text-2xl font-bold">{t("title")}</h1>
        <p className="text-sm text-stone-500">{t("subtitle")}</p>
      </div>
      {error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}

      {claims === null ? (
        <p className="text-sm text-stone-500">{tCommon("loading")}</p>
      ) : queue.length === 0 ? (
        <div className="card p-8 text-center text-stone-500">
          <div className="text-3xl">🧮</div>
          <p className="mt-2">{t("empty")}</p>
        </div>
      ) : (
        <ul className="space-y-3">
          {queue.map((c) => (
            <li key={c.id} className="card card-lift" data-testid={`finance-${c.id}`} data-open-id={c.id}>
              <button
                className="pressable block w-full p-4 text-left"
                onClick={() => setOpenId(openId === c.id ? null : c.id)}
              >
                <ClaimSummaryRow
                  claim={c}
                  trailing={<span className="text-stone-400">{openId === c.id ? "▾" : "▸"}</span>}
                />
              </button>
              {openId === c.id && <PaidCeremony claim={c} onChanged={load} />}
            </li>
          ))}
        </ul>
      )}

      {paid.length > 0 && (
        <div>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-stone-400">{t("paidHeader")}</h2>
          <ul className="space-y-3">
            {paid.map((c) => {
              const isSel = selected.has(c.id);
              return (
                <li
                  key={c.id}
                  className="card card-lift flex items-center gap-3 p-4"
                  data-testid={`paid-${c.id}`}
                  data-open-id={c.id}
                >
                  {/* The primary action is batch-print selection: the whole row
                      toggles the checkbox (the main use case is selecting a few
                      and printing them together). "Paid" is the only state these
                      rows can be in, so there's no status chip — a View button
                      opens the certificate instead. */}
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={isSel}
                    aria-label={t("selectPacket", { name: c.ownerName })}
                    onClick={() => toggle(c.id)}
                    data-testid={`paid-select-${c.id}`}
                    className="pressable flex min-w-0 flex-1 items-center gap-3"
                  >
                    <span
                      aria-hidden="true"
                      className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md border-2 text-xs font-bold transition ${
                        isSel
                          ? "border-indigo-600 bg-indigo-600 text-white"
                          : "border-stone-300 text-transparent"
                      }`}
                    >
                      ✓
                    </span>
                    <ClaimSummaryRow claim={c} />
                  </button>
                  {/* Opens the approval certificate — the signature cover page,
                      the full signed packet, and the offline verification bundle.
                      Served inline, so a new tab keeps the finance page put. */}
                  <PdfLink
                    className="btn-secondary shrink-0"
                    href={`/api/reimbursements/${c.id}/certificate`}
                    filename={`cfcc-certificate-${c.id}.pdf`}
                    testId={`paid-open-${c.id}`}
                  >
                    {t("viewCertificate")}
                  </PdfLink>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {selected.size > 0 && (
        // Floating batch-print toolbar (mirrors the claim page's action bar):
        // count, the two content toggles, and Print all — building one PDF with
        // every selected packet for a single trip to the printer.
        <div className="fixed inset-x-0 bottom-[calc(1rem+env(safe-area-inset-bottom))] z-30 flex justify-center px-4">
          <div className="card flex flex-wrap items-center gap-x-4 gap-y-2 bg-white/95 p-3 shadow-lg backdrop-blur">
            <span className="text-sm font-medium">{t("selectedCount", { count: selected.size })}</span>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={includeReceipts}
                onChange={(e) => {
                  setIncludeReceipts(e.target.checked);
                  savePrintPref({ printIncludeReceipts: e.target.checked });
                }}
                data-testid="print-include-receipts"
              />
              {t("includeReceipts")}
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={includeCertificate}
                onChange={(e) => {
                  setIncludeCertificate(e.target.checked);
                  savePrintPref({ printIncludeCertificate: e.target.checked });
                }}
                data-testid="print-include-certificate"
              />
              {t("includeCertificate")}
            </label>
            {printError && <span className="w-full text-sm text-red-700 sm:w-auto">{printError}</span>}
            {/* Fresh-gesture share fallback (standalone PWA): the built batch
                waits for a tap that still owns its user activation. */}
            {printReady && (
              <button
                className="w-full rounded-lg bg-emerald-50 px-3 py-1.5 text-sm font-semibold text-emerald-700 hover:bg-emerald-100 sm:w-auto"
                onClick={async () => {
                  const outcome = await sharePdf(pdfFile(printReady.blob, printReady.filename));
                  if (outcome === "unavailable") downloadBlob(printReady.blob, printReady.filename);
                  if (outcome !== "blocked") setPrintReady(null);
                }}
                data-testid="print-ready-share"
              >
                {tCommon("pdfReady")} {tCommon("pdfReadyAction")}
              </button>
            )}
            <div className="flex items-center gap-2 sm:ml-auto sm:border-l sm:border-stone-200 sm:pl-4">
              <button className="btn-secondary !px-3" onClick={() => setSelected(new Set())}>
                {t("clearSelection")}
              </button>
              <button
                className="btn-primary !px-4 disabled:opacity-50"
                onClick={printSelected}
                disabled={printing}
                data-testid="print-all"
              >
                {printing ? t("printing") : t("printAll")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function PaidCeremony({ claim, onChanged }: { claim: InboxClaim; onChanged: () => Promise<void> }) {
  const t = useTranslations("Finance");
  const tEsign = useTranslations("Esign");
  const thrown = useThrownErrorMessage();
  const { state, error, loading, needsConnect, connect, connecting, connectError } =
    useClaimChain(claim);
  const [typedName, setTypedName] = useState("");
  const [checkNumber, setCheckNumber] = useState("");
  const [affirmed, setAffirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (state && !typedName) setTypedName(state.env.me.name);
  }, [state, typedName]);

  const thread = state?.thread ?? null;
  const verified =
    !!state &&
    state.chain.anchor.ok &&
    !!thread &&
    thread.state === "approved" &&
    !!thread.decision &&
    state.packetOk;

  async function pay() {
    if (!state || !thread?.decision || !thread.submit) return;
    setBusy(true);
    setActionError(null);
    try {
      await runPaidCeremony(
        {
          id: claim.id,
          signatureLedgerId: claim.signatureLedgerId!,
          signatureLedgerKey: claim.signatureLedgerKey!,
        },
        { checkNumber, typedName },
        {
          approveRef: thread.decision.actionHash,
          packetSha256: (thread.submit.action as { packetSha256: string }).packetSha256,
        }
      );
      await onChanged();
    } catch (err) {
      setActionError(thrown(err, tEsign("ceremonyFailed")));
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 border-t border-stone-100 px-4 pb-4 pt-4">
      {needsConnect && (
        <SigningConnectCard connect={connect} connecting={connecting} error={connectError} />
      )}
      {loading && <p className="text-sm text-stone-500">{tEsign("verifyingChain")}</p>}
      {error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      {state && (
        <>
          <ChainAlert state={state} />
          {!verified && (
            <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
              {tEsign("failClosed")}
            </p>
          )}
          <ThreadSignatures state={state} />
          <AuditDetails state={state} />
          {/* The approved copy carries the approver's ink/name/date and its
              hash is bound inside the signed APPROVE — the treasurer reviews
              the countersigned form, with the untouched original one click
              away. Pre-feature approvals fall back to the original alone. */}
          {state.approvedPacketUrl ? (
            <div className="flex flex-wrap items-center gap-3">
              <PacketLink
                className="btn-secondary inline-block"
                url={state.approvedPacketUrl}
                blob={state.approvedPacketBlob}
                filename={`cfcc-approved-${claim.id}.pdf`}
                testId="open-approved-packet"
              >
                {tEsign("openApprovedPacketButton")}
              </PacketLink>
              <PacketLink
                className="text-sm text-indigo-600 underline"
                url={state.packetUrl}
                blob={state.packetBlob}
                filename={`cfcc-reimbursement-${claim.id}.pdf`}
              >
                {tEsign("openOriginalPacketLink")}
              </PacketLink>
            </div>
          ) : (
            <PacketLink
              className="btn-secondary inline-block"
              url={state.packetUrl}
              blob={state.packetBlob}
              filename={`cfcc-reimbursement-${claim.id}.pdf`}
            >
              {tEsign("openPacketButton")}
            </PacketLink>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-sm font-medium">
              {t("checkNumberLabel")}
              <input className="input mt-1" value={checkNumber} onChange={(e) => setCheckNumber(e.target.value)} data-testid="check-number" />
            </label>
            <label className="block text-sm font-medium">
              {tEsign("typedNameLabel")}
              <input className="input mt-1" value={typedName} onChange={(e) => setTypedName(e.target.value)} data-testid="paid-typed-name" />
            </label>
          </div>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" checked={affirmed} onChange={(e) => setAffirmed(e.target.checked)} data-testid="paid-intent" />
            <span>{tEsign("intentAffirmation")}</span>
          </label>
          {actionError && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{actionError}</p>}
          <div className="flex justify-end">
            <button
              className="btn-primary disabled:opacity-50"
              disabled={!verified || busy || !typedName.trim() || !affirmed}
              onClick={pay}
              data-testid="mark-paid-button"
            >
              {busy ? tEsign("signing") : t("signAndMarkPaid")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

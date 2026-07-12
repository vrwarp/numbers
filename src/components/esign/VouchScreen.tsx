"use client";

/**
 * Voucher's side of the in-person ceremony (docs/ESIGN_DESIGN.md §4.3).
 * The QR scan (native camera → this URL) is the binding channel; the manual
 * fallback requires the candidate's FULL 64-hex key fingerprint — never the
 * 6-digit spoken code, which is grindable. The voucher's one job here is
 * confirming the human in front of them matches the identity on screen.
 */

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import {
  grantRole,
  loadEnv,
  loadRoster,
  revokeMemberKey,
  vouchFor,
  type EsignEnv,
  type VouchSubject,
} from "@/lib/esign/client";
import { fingerprintDisplay, keyFingerprint } from "@/lib/esign/canonical";

function RoleButtons({
  env,
  member,
  onDone,
}: {
  env: EsignEnv;
  member: { userId: string; name: string; role: string; publicKey: string };
  onDone: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  async function set(role: "approver" | "treasurer", revoke: boolean) {
    setBusy(true);
    try {
      await grantRole(env, member.userId, role, revoke);
      await onDone();
    } finally {
      setBusy(false);
    }
  }
  // §4.5 compromised-device path: the member reports the loss in person and
  // the root retires the KEY itself. Their history stays valid; they enroll a
  // fresh key and get re-vouched.
  async function revokeKey() {
    if (
      !confirm(
        `Revoke ${member.name}'s signing key?\n\nDo this when a device that could sign as them was lost or stolen. Everything they already signed stays valid, but the key stops working everywhere — they'll set up signing again and be vouched for again in person.`
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      await revokeMemberKey(env, member.publicKey);
      await onDone();
    } finally {
      setBusy(false);
    }
  }
  return (
    <span className="flex gap-1">
      <button
        className="rounded-lg border border-red-200 px-2 py-0.5 text-xs text-red-700 hover:bg-red-50"
        disabled={busy}
        onClick={revokeKey}
        data-testid={`revoke-key-${member.userId}`}
      >
        revoke key
      </button>
      {member.role === "approver" || member.role === "treasurer" ? (
        <button
          className="rounded-lg border border-stone-200 px-2 py-0.5 text-xs text-stone-500 hover:bg-stone-50"
          disabled={busy}
          onClick={() => set(member.role as "approver" | "treasurer", true)}
        >
          revoke {member.role}
        </button>
      ) : (
        <>
          <button
            className="rounded-lg border border-indigo-200 px-2 py-0.5 text-xs text-indigo-700 hover:bg-indigo-50"
            disabled={busy}
            onClick={() => set("approver", false)}
            data-testid={`grant-approver-${member.userId}`}
          >
            make approver
          </button>
          <button
            className="rounded-lg border border-indigo-200 px-2 py-0.5 text-xs text-indigo-700 hover:bg-indigo-50"
            disabled={busy}
            onClick={() => set("treasurer", false)}
            data-testid={`grant-treasurer-${member.userId}`}
          >
            make treasurer
          </button>
        </>
      )}
    </span>
  );
}

function decodeSubject(c: string): VouchSubject | null {
  try {
    const json = atob(c.replace(/-/g, "+").replace(/_/g, "/"));
    const parsed = JSON.parse(json) as Partial<VouchSubject>;
    if (parsed.uid && parsed.email && parsed.publicKey) {
      return {
        uid: parsed.uid,
        email: parsed.email,
        name: parsed.name || parsed.email,
        publicKey: parsed.publicKey,
      };
    }
  } catch {
    // fall through
  }
  return null;
}

function VouchInner() {
  const params = useSearchParams();
  const [env, setEnv] = useState<EsignEnv | null>(null);
  const [subject, setSubject] = useState<VouchSubject | null>(null);
  const [fingerprint, setFingerprint] = useState<string | null>(null);
  const [manualFp, setManualFp] = useState("");
  const [members, setMembers] = useState<
    {
      userId: string;
      name: string;
      email: string;
      role: string;
      publicKey: string;
      fingerprint: string | null;
    }[]
  >([]);
  const [pending, setPending] = useState<VouchSubject[]>([]);
  // Active roster keys per uid — the source of truth for spotting a RE-KEY
  // vouch (the mirror's members list can't see it: a re-enrolling member's
  // row is already pending on their NEW key while the roster still attests
  // the old one).
  const [activeKeys, setActiveKeys] = useState<Record<string, string[]>>({});
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const encoded = params.get("c");

  useEffect(() => {
    void (async () => {
      try {
        const loaded = await loadEnv();
        setEnv(loaded);
        if (encoded) {
          const s = decodeSubject(encoded);
          if (!s) setError("This vouch link is malformed — rescan the QR");
          else {
            setSubject(s);
            setFingerprint(await keyFingerprint(s.publicKey));
          }
        } else {
          // Manual path: list enrollment candidates awaiting vouches.
          const res = await fetch("/api/esign/pending");
          if (res.ok) setPending(((await res.json()).pending ?? []) as VouchSubject[]);
        }
        const membersRes = await fetch("/api/esign/members");
        if (membersRes.ok) setMembers((await membersRes.json()).members ?? []);
        if (loaded.enabled && loaded.me.identityStatus && loaded.rosterLedgerKey) {
          const { roster } = await loadRoster(loaded);
          const byUid: Record<string, string[]> = {};
          for (const m of roster.members) {
            if (m.revokedAtMs === undefined) (byUid[m.uid] ??= []).push(m.publicKey);
          }
          setActiveKeys(byUid);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not load");
      }
    })();
  }, [encoded]);

  const canVouch = env?.enabled === true && env?.me.identityStatus === "attested";
  const manualMatches = useMemo(() => {
    const typed = manualFp.toLowerCase().replace(/[^0-9a-f]/g, "");
    return typed.length >= 32 && fingerprint?.startsWith(typed);
  }, [manualFp, fingerprint]);

  async function refreshMembers() {
    const res = await fetch("/api/esign/members");
    if (res.ok) setMembers((await res.json()).members ?? []);
  }

  async function submitVouch() {
    if (!env || !subject) return;
    setBusy(true);
    setError(null);
    try {
      await vouchFor(env, subject);
      setDone(true);
      // The vouch may have just attested them — show the fresh roster state
      // (and, for the root, the role buttons for the new member).
      await refreshMembers();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Vouch failed");
    } finally {
      setBusy(false);
    }
  }

  if (!env) return <p className="text-sm text-stone-500">Loading…</p>;

  return (
    <div className="mx-auto max-w-lg space-y-4">
      <h1 className="text-2xl font-bold">Vouch for a member</h1>
      {error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}

      {!canVouch ? (
        <p className="card p-5 text-sm text-stone-600">
          Only attested members can vouch. Enable signing on your{" "}
          <a href="/profile" className="text-indigo-600 underline">profile</a> and get vouched first.
        </p>
      ) : done ? (
        <div className="card space-y-2 p-5" data-testid="vouch-done">
          <div className="text-3xl">✅</div>
          <p className="font-medium">Vouch recorded for {subject?.name}.</p>
          <p className="text-sm text-stone-500">
            They need two member vouches (or one from an approver) to become attested.
          </p>
        </div>
      ) : subject ? (
        <div className="card space-y-4 p-5">
          <div>
            <div className="text-lg font-semibold" data-testid="vouch-subject-name">{subject.name}</div>
            <div className="text-sm text-stone-500">{subject.email}</div>
            {fingerprint && (
              <details className="mt-1 text-xs text-stone-500">
                <summary className="cursor-pointer select-none">Audit details</summary>
                <code className="mt-1 block font-mono">{fingerprintDisplay(fingerprint)}</code>
              </details>
            )}
          </div>
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            <p className="font-semibold">Before you vouch, confirm in person:</p>
            <ul className="mt-1 list-inside list-disc space-y-1">
              <li>The person is physically with you right now.</li>
              <li>This name and email really belong to them.</li>
              <li>You scanned the QR from THEIR screen (not a forwarded link).</li>
            </ul>
          </div>
          {(activeKeys[subject.uid] ?? []).some((k) => k !== subject.publicKey) && (
            <div
              className="rounded-xl border border-indigo-200 bg-indigo-50 p-4 text-sm text-indigo-900"
              data-testid="rekey-notice"
            >
              <p className="font-semibold">This replaces {subject.name}&apos;s previous signing key.</p>
              <p className="mt-1">
                Usually that means a lost device. The moment they&apos;re vouched back in,
                the old key stops counting — everything they signed before stays valid. Be
                extra sure it&apos;s really them.
              </p>
            </div>
          )}
          {!encoded && (
            <div className="space-y-1">
              <label className="text-sm font-medium">
                Type their full key fingerprint (from their screen — the spoken 6-digit code is
                never enough):
              </label>
              <input
                className="input font-mono text-xs"
                placeholder="64 hex characters (≥32 accepted)"
                value={manualFp}
                onChange={(e) => setManualFp(e.target.value)}
                data-testid="manual-fingerprint"
              />
              {!manualMatches && manualFp.length > 0 && (
                <p className="text-xs text-red-600">Fingerprint does not match.</p>
              )}
            </div>
          )}
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              data-testid="vouch-confirm"
            />
            <span>
              I am with <strong>{subject.name}</strong> in person and confirm this identity is theirs.
            </span>
          </label>
          <button
            className="btn-primary w-full disabled:opacity-50"
            disabled={!confirmed || busy || (!encoded && !manualMatches)}
            onClick={submitVouch}
            data-testid="vouch-submit"
          >
            {busy ? "Signing…" : "Sign the vouch"}
          </button>
        </div>
      ) : (
        <div className="card space-y-4 p-5">
          <p className="text-sm text-stone-600">
            Scan the candidate&apos;s QR with your phone camera — it opens this page with their
            identity attached. No QR handy? Pick them below and type their <strong>full key
            fingerprint</strong> (read from their screen; the short spoken code is not enough).
          </p>
          {pending.length === 0 ? (
            <p className="text-sm text-stone-500">Nobody is currently awaiting vouches.</p>
          ) : (
            <ul className="space-y-2">
              {pending.map((p) => (
                <li key={p.uid}>
                  <button
                    className="btn-secondary w-full text-left"
                    onClick={async () => {
                      setSubject(p);
                      setFingerprint(await keyFingerprint(p.publicKey));
                    }}
                  >
                    {p.name} <span className="text-stone-400">({p.email})</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {members.length > 0 && (
        <div className="card p-5">
          <h2 className="text-sm font-semibold text-stone-500">Attested members</h2>
          <ul className="mt-2 space-y-2 text-sm">
            {members.map((m) => (
              <li key={m.userId} className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  {m.name}
                  {m.role !== "member" && (
                    <span className="ml-2 rounded-full bg-indigo-50 px-2 py-0.5 text-xs font-semibold capitalize text-indigo-700">
                      {m.role}
                    </span>
                  )}
                </span>
                <span className="flex items-center gap-2">
                  {/* Role grants are root-signed roster events (§4.3) — only
                      the root's browser can produce them. */}
                  {env.me.role === "admin" && m.userId !== env.me.userId && (
                    <RoleButtons env={env} member={m} onDone={refreshMembers} />
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export default function VouchScreen() {
  return (
    <Suspense fallback={<p className="text-sm text-stone-500">Loading…</p>}>
      <VouchInner />
    </Suspense>
  );
}

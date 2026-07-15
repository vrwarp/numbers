// Assemble the captured admin-interface screenshots into a single annotated,
// self-contained HTML walkthrough (images embedded as data URIs). Companion to
// scripts/walkthrough-admin.mjs. Output path is argv[2].
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const SHOTS = "screenshots/admin";
const out = process.argv[2];

// Structure by tab + cadence — the daily/weekly/monthly axis the admin brief
// asked us to design against, not decorative numbering.
const beats = [
  {
    img: "01-overview.png",
    tab: "Overview",
    cadence: "every visit",
    title: "Problems first, numbers second",
    body: "The landing is a triage card, not a report. Server-computed checks surface only what needs a hand — no API key, a missing context doc, approvals gone stale, failed AI calls — each with a one-tap jump to the fix. Healthy deployments say so in one green line. Below, five honest headline counts.",
  },
  {
    img: "02-context.png",
    tab: "Church Context",
    cadence: "as vocabulary changes",
    title: "The main job: teach the AI your church",
    body: "The document fed to every “Suggest ministry” call — group names, recurring events, labeling rules the chart of accounts can’t resolve. Previously hand-edited on the data volume; now a plain editor with a live byte budget, the exact file path, and a saved-hot banner: the next suggestion uses it immediately. A standing amber note reminds you it is sent to your AI provider.",
  },
  {
    img: "03-settings.png",
    tab: "Settings",
    cadence: "setup · rare",
    title: "Configure the deployment without a shell",
    body: "Plain-language fields grouped by concern, each tagged with its real env name for operators who know it. Secrets are <b>write-only</b> — the form shows only whether one is <em>set</em>, never its value, and never echoes it back. Numbers and enums validate before anything touches <span class=\"mono\">config.json</span>. Auth-critical and bootstrap keys are deliberately absent, so no admin can lock the deployment out through the form.",
  },
  {
    img: "04-usage.png",
    tab: "Usage",
    cadence: "weekly",
    title: "Honest counts, real money",
    body: "Totals, claims by status, and a 30-day AI-call chart — <span class=\"good\">emerald</span> succeeded over <span class=\"bad\">red</span> failed, the app’s own semantics. The only dollar figure anywhere in admin is the <b>real</b> settled/paid total from the ledger; there is no invented per-model “spend.”",
  },
  {
    img: "05-logs.png",
    tab: "Logs",
    cadence: "when troubleshooting",
    title: "The whole trail, failures first",
    body: "Every AI call and every audited mutation, across all users. It opens on <b>problems</b> — extraction failures — because that’s why an admin is here; one toggle widens it to all calls, and the activity log filters by action. Read-only: this is the record, not a control panel.",
  },
  {
    img: "06-members.png",
    tab: "Members",
    cadence: "monthly",
    title: "Roster mirror & the vouch-for chain",
    body: "The verified-mirror directory — role, signing enrollment, activity — plus the e-sign master switch and rollout allowlist. Below, the cryptographic vouch-for chain re-verified from the ledger in the browser. Note the admin’s row still reads <em>Member</em>: seeding via <span class=\"mono\">ADMIN_EMAILS</span> grants app access without ever rewriting the signature roster.",
  },
];

const encoded = await Promise.all(
  beats.map(async (b) => {
    const buf = await readFile(path.join(SHOTS, b.img));
    return { ...b, uri: `data:image/png;base64,${buf.toString("base64")}` };
  })
);

const card = (b, i) => `
  <figure class="beat">
    <div class="shot"><img alt="${b.tab} tab" src="${b.uri}" loading="lazy" /></div>
    <figcaption>
      <div class="eyebrow-row">
        <span class="tabname">${b.tab}</span>
        <span class="cadence">${b.cadence}</span>
      </div>
      <h2>${b.title}</h2>
      <p>${b.body}</p>
    </figcaption>
  </figure>`;

const html = `<title>Numbers — admin interface walkthrough</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  :root{
    --ground:#f5f6f9; --panel:#ffffff; --ink:#171a21; --muted:#565c6b; --faint:#878ea0;
    --border:#e4e7ef; --line:#eceef4;
    --accent:#4f46e5; --accent-soft:#eef0ff;
    --good:#0f9d6f; --good-soft:#e6f6ef; --bad:#dc4b52; --bad-soft:#fdecec; --warn:#b45309;
    --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
    --sans:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  }
  @media (prefers-color-scheme:dark){:root{
    --ground:#0d0f14; --panel:#171a22; --ink:#e9ebf2; --muted:#a0a6b6; --faint:#6d7488;
    --border:#262b38; --line:#20242f;
    --accent:#8b83ff; --accent-soft:#20203a;
    --good:#4fcf9c; --good-soft:#122820; --bad:#f0787d; --bad-soft:#2a1719; --warn:#e0a45c;
  }}
  :root[data-theme="light"]{--ground:#f5f6f9;--panel:#fff;--ink:#171a21;--muted:#565c6b;--faint:#878ea0;--border:#e4e7ef;--line:#eceef4;--accent:#4f46e5;--accent-soft:#eef0ff;--good:#0f9d6f;--good-soft:#e6f6ef;--bad:#dc4b52;--bad-soft:#fdecec;--warn:#b45309;}
  :root[data-theme="dark"]{--ground:#0d0f14;--panel:#171a22;--ink:#e9ebf2;--muted:#a0a6b6;--faint:#6d7488;--border:#262b38;--line:#20242f;--accent:#8b83ff;--accent-soft:#20203a;--good:#4fcf9c;--good-soft:#122820;--bad:#f0787d;--bad-soft:#2a1719;--warn:#e0a45c;}
  *{box-sizing:border-box;}
  html{-webkit-text-size-adjust:100%;}
  body{margin:0;background:var(--ground);color:var(--ink);font-family:var(--sans);line-height:1.6;-webkit-font-smoothing:antialiased;}
  .wrap{max-width:960px;margin:0 auto;padding:0 24px 104px;}
  header.mast{padding:64px 0 32px;border-bottom:1px solid var(--border);}
  .eyebrow{font-family:var(--mono);font-size:12px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:var(--accent);margin:0 0 15px;}
  h1{font-size:clamp(30px,5.2vw,46px);line-height:1.04;letter-spacing:-.024em;font-weight:800;margin:0 0 16px;text-wrap:balance;max-width:17ch;}
  .lede{font-size:18px;color:var(--muted);max-width:64ch;margin:0;}
  .lede b{color:var(--ink);font-weight:640;}
  .legend{display:flex;flex-wrap:wrap;gap:8px;margin-top:22px;}
  .legend span{font-family:var(--mono);font-size:11.5px;font-weight:600;padding:4px 10px;border-radius:999px;border:1px solid var(--border);color:var(--muted);}
  .legend .g{color:var(--good);background:var(--good-soft);border-color:transparent;}
  .legend .b{color:var(--bad);background:var(--bad-soft);border-color:transparent;}
  .beats{display:flex;flex-direction:column;gap:30px;padding-top:46px;}
  .beat{display:grid;grid-template-columns:minmax(0,1.15fr) 1fr;gap:34px;align-items:center;background:var(--panel);border:1px solid var(--border);border-radius:18px;padding:20px;}
  .beat:nth-child(even){grid-template-columns:1fr minmax(0,1.15fr);}
  .beat:nth-child(even) figcaption{order:-1;}
  @media (max-width:720px){.beat,.beat:nth-child(even){grid-template-columns:1fr;gap:16px;}.beat:nth-child(even) figcaption{order:0;}}
  .shot{background:var(--ground);border:1px solid var(--line);border-radius:12px;padding:8px;overflow:hidden;max-height:520px;display:flex;}
  .shot img{display:block;width:100%;height:auto;border-radius:7px;object-fit:cover;object-position:top;}
  figcaption{padding:4px 6px;}
  .eyebrow-row{display:flex;align-items:center;gap:10px;margin-bottom:11px;flex-wrap:wrap;}
  .tabname{font-family:var(--mono);font-size:12px;font-weight:700;letter-spacing:.02em;color:var(--accent);background:var(--accent-soft);padding:3px 9px;border-radius:7px;}
  .cadence{font-size:11.5px;color:var(--faint);text-transform:uppercase;letter-spacing:.08em;}
  figcaption h2{font-size:21px;line-height:1.2;letter-spacing:-.017em;font-weight:730;margin:0 0 8px;text-wrap:balance;}
  figcaption p{margin:0;font-size:15px;color:var(--muted);max-width:52ch;}
  figcaption p b{color:var(--ink);font-weight:640;}
  .mono{font-family:var(--mono);font-size:.9em;background:var(--accent-soft);color:var(--accent);padding:1px 5px;border-radius:5px;}
  .good{color:var(--good);font-weight:640;}
  .bad{color:var(--bad);font-weight:640;}
  .foot{margin-top:40px;padding:22px 24px;border:1px solid var(--border);border-radius:16px;background:var(--panel);color:var(--muted);font-size:14.5px;line-height:1.65;}
  .foot b{color:var(--ink);}
  .foot p{margin:0 0 10px;}
  .foot p:last-child{margin:0;}
  .foot .rule{font-family:var(--mono);font-size:12px;color:var(--faint);}
</style>
<div class="wrap">
  <header class="mast">
    <p class="eyebrow">Numbers · admin · shipped</p>
    <h1>The church admin, gathered into one place.</h1>
    <p class="lede">Real captures from the app on <b>AI_MOCK</b>. Everything that used to need shell access to the <span class="mono">/data</span> volume — editing the <b>church-context</b> doc the AI reads, configuring the deployment, watching usage and the audit trail, reviewing the signing roster — now lives behind a single admin-gated area. Shaped by a five-round ideation ↔ admin-critique loop (<span class="mono">docs/ADMIN.md</span>).</p>
    <div class="legend"><span>tab · cadence</span><span class="g">✓ healthy</span><span class="b">! needs attention</span></div>
  </header>
  <div class="beats">
    ${encoded.map(card).join("\n")}
  </div>
  <div class="foot">
    <p>Invariants held throughout. Admin gates like every cross-tenant surface — <b>404, never 403</b>. Every mutation writes an <b>AuditEvent</b> with <b>secrets redacted</b>. Money stays integer cents; no per-model spend is invented. Seeding an admin via <span class="mono">ADMIN_EMAILS</span> is an app-surface grant that <b>never</b> rewrites the verified signature roster.</p>
    <p class="rule">253 unit tests · full production build · an e2e covering member lockout + the church-context save — all green.</p>
  </div>
</div>`;

await writeFile(out, html);
console.log(`wrote ${out} (${(Buffer.byteLength(html) / 1024).toFixed(0)} KB)`);

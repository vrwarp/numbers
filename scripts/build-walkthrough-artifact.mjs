// Assemble the captured AI-box screenshots into a single annotated HTML
// walkthrough (self-contained: images embedded as data URIs). Output path is
// passed as argv[2].
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const SHOTS = "screenshots/ai-box";
const out = process.argv[2];

const beats = [
  {
    img: "01-ai-zone-idle.png",
    n: "01",
    title: "The box at rest",
    call: null,
    body: "The describe-field is now a distinct violet <em>surface</em>, not one more grey form control — so the eye reads “AI” before reading a word. Roomy multi-line prompt (15–16px, no zoom-on-focus), a real Send button, and the manual dropdowns demoted below an <b>“or set it yourself”</b> divider.",
  },
  {
    img: "02-candidates.png",
    n: "02",
    title: "Describe → ranked candidates",
    call: "⚡ model call 1",
    body: "One sentence in, up to <b>three ranked, already-resolved</b> budget lines out — the realistic ambiguity is same event, different budget line. Each row is a full pairing you can tap; <b>tapping applies it with no further model call.</b>",
  },
  {
    img: "03-something-else.png",
    n: "03",
    title: "Reject them all → one follow-up",
    call: null,
    body: "“Something else…” opens the single terminal prompt. This is the <em>only</em> control that will spend a second model call — every candidate tap above is free.",
  },
  {
    img: "04-resolved.png",
    n: "04",
    title: "The follow-up commits",
    call: "⚡ model call 2 · last",
    body: "The extra detail (“it was VBS, not a retreat”) steers the second — and final — call to a single confident answer. Its escape hatch is now “pick manually,” so <b>no third call is reachable.</b>",
  },
  {
    img: "05-applied.png",
    n: "05",
    title: "Tap Apply → fans onto every row",
    call: "✓ no call",
    body: "Applying reuses the existing fan-out + one-click Undo. The manual dropdowns below mirror the applied category. The AI only ever <b>suggests</b> — you still verify each amount, and the PDF gate is untouched.",
  },
  {
    img: "06-fanned-out.png",
    n: "06",
    title: "…across the whole claim",
    call: "✓ no call",
    tall: true,
    body: "Every receipt’s row now carries the applied budget line — one tap categorized the entire multi-receipt claim.",
  },
  {
    img: "07-confident-single.png",
    n: "07",
    title: "The confident case",
    call: "⚡ model call 1",
    body: "When one answer is obvious, the model returns a single candidate — rendered as the familiar suggestion banner (the same testids the existing suite asserts, so all e2e stayed green).",
  },
];

const encoded = await Promise.all(
  beats.map(async (b) => {
    const buf = await readFile(path.join(SHOTS, b.img));
    return { ...b, uri: `data:image/png;base64,${buf.toString("base64")}` };
  })
);

const card = (b) => `
  <figure class="beat${b.tall ? " tall" : ""}">
    <div class="shot"><img alt="${b.title}" src="${b.uri}" /></div>
    <figcaption>
      <div class="cap-head">
        <span class="beat-n">${b.n}</span>
        <h2>${b.title}</h2>
      </div>
      ${b.call ? `<span class="call ${b.call.startsWith("✓") ? "free" : "spend"}">${b.call}</span>` : ""}
      <p>${b.body}</p>
    </figcaption>
  </figure>`;

const html = `<title>AI box — visual walkthrough</title>
<style>
  :root{
    --ground:#f4f3f9; --surface:#fff; --ink:#1c1b22; --muted:#5d5a6b; --faint:#8a889a;
    --border:#e6e4ef; --violet:#6d28d9; --violet-soft:#f3edff; --indigo:#4f46e5;
    --free:#0f9d6f; --free-soft:#e7f7f0; --spend:#6d28d9; --spend-soft:#f1eafe;
    --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
    --sans:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  }
  @media (prefers-color-scheme:dark){:root{
    --ground:#0f0f15; --surface:#1a1922; --ink:#ececf3; --muted:#a3a1b4; --faint:#726f86;
    --border:#2a2836; --violet:#b79cff; --violet-soft:#241d38; --indigo:#8b83ff;
    --free:#57d3a3; --free-soft:#14271f; --spend:#b79cff; --spend-soft:#241d38;
  }}
  :root[data-theme="light"]{--ground:#f4f3f9;--surface:#fff;--ink:#1c1b22;--muted:#5d5a6b;--faint:#8a889a;--border:#e6e4ef;--violet:#6d28d9;--violet-soft:#f3edff;--indigo:#4f46e5;--free:#0f9d6f;--free-soft:#e7f7f0;--spend:#6d28d9;--spend-soft:#f1eafe;}
  :root[data-theme="dark"]{--ground:#0f0f15;--surface:#1a1922;--ink:#ececf3;--muted:#a3a1b4;--faint:#726f86;--border:#2a2836;--violet:#b79cff;--violet-soft:#241d38;--indigo:#8b83ff;--free:#57d3a3;--free-soft:#14271f;--spend:#b79cff;--spend-soft:#241d38;}
  *{box-sizing:border-box;}
  body{margin:0;background:var(--ground);color:var(--ink);font-family:var(--sans);line-height:1.55;-webkit-font-smoothing:antialiased;}
  .wrap{max-width:920px;margin:0 auto;padding:0 24px 96px;}
  header.mast{padding:60px 0 30px;border-bottom:1px solid var(--border);}
  .eyebrow{font-size:12px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--violet);margin:0 0 13px;}
  h1{font-size:clamp(30px,5vw,44px);line-height:1.05;letter-spacing:-.022em;font-weight:800;margin:0 0 15px;text-wrap:balance;max-width:18ch;}
  .lede{font-size:18px;color:var(--muted);max-width:60ch;margin:0;}
  .lede b{color:var(--ink);font-weight:650;}
  .beats{display:flex;flex-direction:column;gap:34px;padding-top:44px;}
  .beat{display:grid;grid-template-columns:300px 1fr;gap:32px;align-items:center;}
  .beat.tall{align-items:start;}
  @media (max-width:680px){.beat{grid-template-columns:1fr;gap:18px;}}
  .shot{background:#f5f5f4;border:1px solid #e7e5e4;border-radius:20px;padding:12px;box-shadow:0 1px 2px rgba(20,20,40,.06),0 10px 30px rgba(20,20,40,.08);}
  .shot img{display:block;width:100%;border-radius:10px;}
  .beat.tall .shot{max-height:560px;overflow-y:auto;}
  .cap-head{display:flex;align-items:baseline;gap:12px;margin-bottom:10px;}
  .beat-n{font-family:var(--mono);font-size:13px;font-weight:700;color:var(--faint);}
  figcaption h2{font-size:22px;letter-spacing:-.015em;font-weight:730;margin:0;text-wrap:balance;}
  .call{display:inline-flex;align-items:center;font-family:var(--mono);font-size:11.5px;font-weight:700;letter-spacing:.02em;padding:4px 10px;border-radius:7px;margin-bottom:11px;}
  .call.spend{color:var(--spend);background:var(--spend-soft);}
  .call.free{color:var(--free);background:var(--free-soft);}
  figcaption p{margin:0;font-size:15.5px;color:var(--muted);max-width:52ch;}
  figcaption p b{color:var(--ink);font-weight:650;}
  .foot{margin-top:52px;padding-top:24px;border-top:1px solid var(--border);color:var(--muted);font-size:14.5px;}
  .foot b{color:var(--ink);}
  .legend{display:flex;flex-wrap:wrap;gap:10px;margin-top:20px;}
  .legend span{font-family:var(--mono);font-size:11.5px;font-weight:700;padding:4px 10px;border-radius:7px;}
  .legend .spend{color:var(--spend);background:var(--spend-soft);}
  .legend .free{color:var(--free);background:var(--free-soft);}
</style>
<div class="wrap">
  <header class="mast">
    <p class="eyebrow">Numbers · claim review · shipped</p>
    <h1>The AI box, rebuilt — a bounded two-turn conversation.</h1>
    <p class="lede">Real captures from the app running on <b>AI_MOCK</b>. Describe a claim and the AI returns up to <b>three ranked, pre-resolved candidates</b>; tapping one applies it free. Only <b>“Something else…”</b> spends a second — and final — model call.</p>
    <div class="legend"><span class="spend">⚡ = model call</span><span class="free">✓ = free local tap</span></div>
  </header>
  <div class="beats">
    ${encoded.map(card).join("\n")}
  </div>
  <p class="foot">Invariant held throughout: the AI only ever <b>suggests</b> — a human taps to apply and still verifies every row before the PDF. The human-in-the-loop gate, fan-out, and audit trail are unchanged; both model calls write an <b>ExtractionLog</b>. All 232 unit tests and the panel e2e specs pass.</p>
</div>`;

await writeFile(out, html);
console.log(`wrote ${out} (${(Buffer.byteLength(html) / 1024).toFixed(0)} KB)`);

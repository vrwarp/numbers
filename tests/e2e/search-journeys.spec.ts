import { test, expect, type Page } from "@playwright/test";
import path from "path";
import fs from "fs";
import { PrismaClient } from "@prisma/client";
import { completeProfile, signInAs, uploadReceipts } from "./helpers";

/**
 * Search user journeys on RECORDED REAL EMBEDDINGS (docs/SEARCH_DESIGN.md §11):
 * the replay server (start-server.sh) serves verbatim vectors captured from
 * the production endpoint by `npm run record:embeddings`, so these journeys
 * assert GENUINE model geometry — bilingual receipts, Chinese and English
 * queries, cross-language retrieval in both directions, and the actual cosine
 * scores (from embeddings.json's expectedScores matrix). If image
 * normalization ever stops being byte-deterministic, the score-fidelity test
 * fails loudly — that determinism is itself under test.
 */

const FIXTURES = path.resolve("tests/e2e/embedding-fixtures");
const recording = JSON.parse(fs.readFileSync(path.join(FIXTURES, "embeddings.json"), "utf8")) as {
  expectedScores: Record<string, Record<string, number>>;
};

// Mirrors the manifest — receipt id → its upload note.
const RECEIPT_NOTES: Record<string, string> = {
  "costco-tables": "folding tables and paper towels for the youth retreat",
  "starbucks-coffee": "coffee meeting with Pastor Lin",
  "zh-grocery": "退修会零食",
  "zh-restaurant": "教会聚餐",
};

function e2ePrisma(): PrismaClient {
  return new PrismaClient({
    datasources: { db: { url: `file:${path.resolve("./.e2e-data/numbers.db")}` } },
  });
}

type Item = { kind: string; id: string; note?: string; score?: number };
type SearchBody = {
  exact: Item[];
  best: Item | null;
  groups: { year: number; items: Item[] }[];
};

/** All returned items in rank order: exact strip, best pin, then year groups. */
function ranked(r: SearchBody): Item[] {
  return [...r.exact, ...(r.best ? [r.best] : []), ...r.groups.flatMap((g) => g.items)];
}

async function search(page: Page, body: object): Promise<SearchBody> {
  const res = await page.request.post("/api/search", { data: body });
  if (!res.ok()) {
    throw new Error(`search ${res.status()}: ${(await res.text()).slice(0, 300)} — body ${JSON.stringify(body)}`);
  }
  return res.json();
}

/** Upload the four bilingual fixture receipts (each with its manifest note)
 *  and wait until every one is indexed. Returns note → receiptId. */
async function seedCorpus(page: Page): Promise<Map<string, string>> {
  for (const [id, note] of Object.entries(RECEIPT_NOTES)) {
    await uploadReceipts(page, [path.join(FIXTURES, `${id}.png`)], note);
  }
  const receipts = (await (await page.request.get("/api/receipts")).json()).receipts as {
    id: string;
    note: string;
  }[];
  expect(receipts).toHaveLength(4);
  // Wait for the queue to drain (myPendingReceipts → 0).
  await expect
    .poll(
      async () => {
        const res = await page.request.post("/api/search", { data: { query: "x" } });
        const body = await res.json();
        return body.indexed.myPendingReceipts;
      },
      { timeout: 30_000, intervals: [500] }
    )
    .toBe(0);
  return new Map(receipts.map((r) => [r.note, r.id]));
}

function rankOf(items: Item[], id: string): number {
  const i = items.findIndex((x) => x.id === id);
  expect(i, `receipt ${id} missing from results`).toBeGreaterThanOrEqual(0);
  return i;
}

test("bilingual corpus: en→en, zh→en, en→zh, zh→zh queries all rank the right receipt (real geometry)", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await signInAs(page, `journeys-${testInfo.project.name}-r${testInfo.retry}@example.com`, "Journey Member");
  await completeProfile(page);
  await page.goto("/");
  const byNote = await seedCorpus(page);
  const starbucks = byNote.get(RECEIPT_NOTES["starbucks-coffee"])!;
  const grocery = byNote.get(RECEIPT_NOTES["zh-grocery"])!;
  const restaurant = byNote.get(RECEIPT_NOTES["zh-restaurant"])!;
  const costco = byNote.get(RECEIPT_NOTES["costco-tables"])!;

  // en → en: recorded 0.673 vs ≤0.41 for every other receipt.
  let items = ranked(await search(page, { query: "coffee at Starbucks", types: ["receipt"] }));
  expect(items[0].id).toBe(starbucks);

  // zh → en (cross-language): 星巴克的咖啡 → the ENGLISH Starbucks image.
  items = ranked(await search(page, { query: "星巴克的咖啡", types: ["receipt"] }));
  expect(items[0].id).toBe(starbucks);

  // en → zh (cross-language): the CHINESE grocery receipt beats the other
  // non-snack receipts (costco genuinely contains a snack pack — real
  // ambiguity, so top-2 with the restaurant/starbucks strictly below).
  items = ranked(await search(page, { query: "snacks for the retreat", types: ["receipt"] }));
  expect(rankOf(items, grocery)).toBeLessThanOrEqual(1);
  expect(rankOf(items, grocery)).toBeLessThan(rankOf(items, restaurant));
  expect(rankOf(items, grocery)).toBeLessThan(rankOf(items, starbucks));

  // zh → zh: 退修会的零食 → 永和超级市场 receipt, decisively (0.595 vs ≤0.47).
  items = ranked(await search(page, { query: "退修会的零食", types: ["receipt"] }));
  expect(items[0].id).toBe(grocery);

  // en → en (tables): recorded 0.538 vs ≤0.36 semantic — exact pass may also
  // hit the note; either way the costco receipt is rank 0.
  items = ranked(await search(page, { query: "folding tables for the youth retreat", types: ["receipt"] }));
  expect(items[0].id).toBe(costco);
});

test("score fidelity: the app serves the RECORDED cosine scores end-to-end (admin test box)", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const email = `scores-${testInfo.project.name}-r${testInfo.retry}@example.com`;
  await signInAs(page, email, "Score Admin");
  const prisma = e2ePrisma();
  try {
    await prisma.user.update({ where: { email }, data: { role: "admin" } });
  } finally {
    await prisma.$disconnect();
  }
  await page.goto("/");
  const byNote = await seedCorpus(page);
  const starbucks = byNote.get(RECEIPT_NOTES["starbucks-coffee"])!;
  const grocery = byNote.get(RECEIPT_NOTES["zh-grocery"])!;

  // The only surface with visible scores (§10). Both vectors are verbatim
  // recordings, so the served score must equal the recorded real cosine —
  // this also proves the image pipeline stayed byte-deterministic.
  for (const [query, receiptId, expectedKey] of [
    ["coffee at Starbucks", starbucks, ["q-en-coffee", "starbucks-coffee"]],
    ["星巴克的咖啡", starbucks, ["q-zh-coffee", "starbucks-coffee"]],
    ["退修会的零食", grocery, ["q-zh-snacks", "zh-grocery"]],
  ] as const) {
    const res = await page.request.post("/api/admin/embeddings/test-query", {
      data: { query },
    });
    expect(res.ok()).toBe(true);
    const items = ranked(await res.json());
    const hit = items.find((i) => i.id === receiptId);
    expect(hit, `${query} must return the receipt`).toBeTruthy();
    const expected = recording.expectedScores[expectedKey[0]][expectedKey[1]];
    expect(hit!.score, `${query} score vs recorded`).toBeGreaterThan(expected - 0.02);
    expect(hit!.score, `${query} score vs recorded`).toBeLessThan(expected + 0.02);
  }
});

test("amount journeys: exact cents match for $ and full-width IME input", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await signInAs(page, `amounts-${testInfo.project.name}-r${testInfo.retry}@example.com`, "Amount Member");
  await page.goto("/");
  await uploadReceipts(page, [path.join(FIXTURES, "costco-tables.png")], RECEIPT_NOTES["costco-tables"]);
  const receiptId = (await (await page.request.get("/api/receipts")).json()).receipts[0].id;

  // AI_MOCK extraction stamps the printed total ($102.10) at claim creation.
  const claimRes = await page.request.post("/api/reimbursements", { data: { receiptIds: [receiptId] } });
  expect(claimRes.status()).toBe(201);

  for (const q of ["$102.10", "１０２.１０", "102.10"]) {
    const r = await search(page, { query: q });
    expect(r.exact.length, `exact matches for ${JSON.stringify(q)}`).toBeGreaterThan(0);
    expect(ranked(r).some((i) => i.id === receiptId)).toBe(true);
  }
});

test("zh claim journey: draft indexes after idle, survives freezing, found by a Chinese query", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await signInAs(page, `zhclaim-${testInfo.project.name}-r${testInfo.retry}@example.com`, "Banquet Member");
  await page.goto("/");
  await uploadReceipts(page, [path.join(FIXTURES, "zh-restaurant.png")], RECEIPT_NOTES["zh-restaurant"]);
  const receiptId = (await (await page.request.get("/api/receipts")).json()).receipts[0].id;
  const claimRes = await page.request.post("/api/reimbursements", { data: { receiptIds: [receiptId] } });
  const claimId = (await claimRes.json()).reimbursement.id;

  // claimDescription inherited 教会聚餐 from the note. The DRAFT indexes after
  // the shrunk idle window; the composite projects onto the recorded banquet
  // anchor, and the recorded zh query ranks it (real q·anchor = 0.83).
  await expect
    .poll(
      async () => {
        const r = await search(page, { query: "教会聚餐的报销", types: ["claim"] });
        return ranked(r).some((i) => i.id === claimId);
      },
      { timeout: 30_000, intervals: [500] }
    )
    .toBe(true);

  // Freeze it (verify the row, generate the PDF) — still searchable.
  const item = (await (await page.request.get(`/api/reimbursements/${claimId}`)).json())
    .reimbursement.lineItems[0];
  await page.request.patch(`/api/line-items/${item.id}`, {
    data: { ministry: "General Fund", isVerified: true },
  });
  expect((await page.request.post(`/api/reimbursements/${claimId}/pdf`)).status()).toBe(200);
  await expect
    .poll(
      async () => {
        const r = await search(page, { query: "教会聚餐的报销", types: ["claim"] });
        const hit = ranked(r).find((i) => i.id === claimId) as { status?: string } | undefined;
        return hit?.status;
      },
      { timeout: 30_000, intervals: [500] }
    )
    .toBe("generated");
});

test("decided journey: an approver browses the claims they decided, newest first, no query needed", async ({ browser }, testInfo) => {
  test.setTimeout(120_000);
  const suffix = `${testInfo.project.name}-r${testInfo.retry}`;
  // A member freezes a claim…
  const member = await (await browser.newContext()).newPage();
  await signInAs(member, `decided-member-${suffix}@example.com`, "Decided Member");
  await completeProfile(member);
  await member.goto("/");
  await uploadReceipts(member, [path.join(FIXTURES, "zh-grocery.png")], RECEIPT_NOTES["zh-grocery"]);
  const receiptId = (await (await member.request.get("/api/receipts")).json()).receipts[0].id;
  const claimId = (
    await (await member.request.post("/api/reimbursements", { data: { receiptIds: [receiptId] } })).json()
  ).reimbursement.id;
  const item = (await (await member.request.get(`/api/reimbursements/${claimId}`)).json())
    .reimbursement.lineItems[0];
  await member.request.patch(`/api/line-items/${item.id}`, {
    data: { ministry: "General Fund", isVerified: true },
  });
  expect((await member.request.post(`/api/reimbursements/${claimId}/pdf`)).status()).toBe(200);

  // …the approver decided it (mirror columns written directly, like every
  // role-flow e2e — the ledger ceremony is the esign suite's job).
  const approverEmail = `decided-approver-${suffix}@example.com`;
  const approver = await (await browser.newContext()).newPage();
  await signInAs(approver, approverEmail, "Decided Approver");
  const prisma = e2ePrisma();
  try {
    const a = await prisma.user.findUnique({ where: { email: approverEmail } });
    await prisma.user.update({ where: { id: a!.id }, data: { role: "approver" } });
    await prisma.reimbursement.update({
      where: { id: claimId },
      data: { status: "approved", approverUserId: a!.id, decidedAt: new Date() },
    });
  } finally {
    await prisma.$disconnect();
  }

  // Empty-query browse in the decided scope returns it, newest first.
  const browse = await search(approver, { query: "", scope: "decided" });
  const items = ranked(browse);
  expect(items.some((i) => i.id === claimId)).toBe(true);

  // And the decided scope narrows a real query to their decided set only.
  const scoped = await search(approver, { query: "退修会的零食", scope: "decided" });
  expect(ranked(scoped).every((i) => i.id === claimId || i.id === receiptId)).toBe(true);

  // The UI shows the browse (three-segment scope → decided → results).
  await approver.goto("/search");
  await approver.getByTestId("search-scope-filter").getByRole("radio").nth(2).click();
  await expect(approver.locator(`[data-testid="search-result-claim-${claimId}"]`)).toBeVisible();
});

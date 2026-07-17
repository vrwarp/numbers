import { test, expect, type Page } from "@playwright/test";
import path from "path";
import { PrismaClient } from "@prisma/client";
import { makeReceiptFixture, signInAs, uploadReceipts } from "./helpers";

/**
 * Semantic search (docs/SEARCH_DESIGN.md §11): mock embeddings are
 * similarity-meaningful (token bag), the draft-idle debounce is shrunk to
 * 1.5 s and the worker poll to 500 ms by start-server.sh, so ingest timing is
 * testable for real. Role grants are written straight to the e2e DB, same as
 * admin.spec.ts.
 */

function e2ePrisma(): PrismaClient {
  return new PrismaClient({
    datasources: { db: { url: `file:${path.resolve("./.e2e-data/numbers.db")}` } },
  });
}

async function grantRole(email: string, role: string): Promise<void> {
  const prisma = e2ePrisma();
  try {
    await prisma.user.update({ where: { email: email.toLowerCase() }, data: { role } });
  } finally {
    await prisma.$disconnect();
  }
}

async function setPauses(
  email: string,
  pauses: { approvalsPaused?: boolean; financePaused?: boolean; adminPaused?: boolean }
): Promise<void> {
  const prisma = e2ePrisma();
  try {
    await prisma.user.update({ where: { email: email.toLowerCase() }, data: pauses });
  } finally {
    await prisma.$disconnect();
  }
}

/** Poll the search API until a predicate holds (worker indexing is async). */
async function searchUntil(
  page: Page,
  body: object,
  pred: (r: { exact: unknown[]; best: unknown; groups: { items: unknown[] }[] }) => boolean,
  timeoutMs = 30_000
) {
  let last: unknown = null;
  await expect
    .poll(
      async () => {
        const res = await page.request.post("/api/search", { data: body });
        if (!res.ok()) return `status ${res.status()}`;
        const json = await res.json();
        last = json;
        return pred(json);
      },
      { timeout: timeoutMs, intervals: [500] }
    )
    .toBe(true);
  return last as { exact: { id: string }[]; best: { id: string } | null; groups: { year: number; items: { id: string; kind: string; claims?: { status: string }[] }[] }[] };
}

const anyHit = (r: { exact: unknown[]; best: unknown; groups: { items: unknown[] }[] }) =>
  r.exact.length > 0 || !!r.best || r.groups.some((g) => g.items.length > 0);

test("member: upload → indexed → exact + semantic → Find in Receipts lands with a pulse", async ({ page }, testInfo) => {
  await signInAs(page, `searcher-${testInfo.project.name}-r${testInfo.retry}@example.com`, "Searcher");
  await page.goto("/");
  await uploadReceipts(
    page,
    [await makeReceiptFixture("tables.jpg")],
    "folding tables for youth retreat"
  );

  // The upload enqueued an embed; the worker wake makes this fast.
  await searchUntil(page, { query: "youth retreat tables" }, anyHit);

  // UI: exact match (note contains all terms) + unclaimed state + action.
  await page.getByTestId("shoebox-search-pill").click();
  await page.waitForURL(/\/search\?type=receipt/);
  await expect(page.getByTestId("search-input")).toBeFocused();
  await expect(page.getByTestId("search-type-chip")).toBeVisible();
  await page.getByTestId("search-input").fill("folding tables youth");
  await page.getByTestId("search-submit").click();
  const exact = page.getByTestId("search-exact-section");
  await expect(exact).toBeVisible();
  await expect(exact.getByText("Not on a claim")).toBeVisible();

  // Whole-card tap = Find in Receipts → lands on / with the pulse contract.
  await exact.locator('[data-testid^="search-result-receipt-"] a, a[data-testid^="search-result-receipt-"]').first().click();
  await page.waitForURL(/\/(\?.*)?$/);
  await expect(page.locator(".highlight-pulse")).toBeVisible({ timeout: 10_000 });
  // Param stripped once handled (back/refresh must not re-scroll).
  await expect.poll(() => page.url().includes("open=")).toBe(false);
});

test("draft claims index after the idle window and re-index on edit", async ({ page }, testInfo) => {
  await signInAs(page, `drafts-${testInfo.project.name}-r${testInfo.retry}@example.com`, "Drafter");
  await page.goto("/");
  await uploadReceipts(page, [await makeReceiptFixture("retreat.jpg")], "retreat snacks");
  await page.locator('[data-testid^="receipt-card-"]').first().click();
  await page.getByTestId("generate-claim").click();
  await page.waitForURL(/\/claims\/[^/]+$/, { timeout: 30_000 });
  const claimId = page.url().match(/claims\/([^/]+)/)![1];

  // claimDescription inherited the note ("retreat snacks") → after the 1.5 s
  // debounce the DRAFT becomes searchable.
  const hit = await searchUntil(
    page,
    { query: "retreat snacks", types: ["claim"] },
    (r) => [...r.groups.flatMap((g) => g.items), ...(r.best ? [r.best] : []), ...r.exact].some(
      (i) => (i as { id: string }).id === claimId
    )
  );
  expect(hit).toBeTruthy();

  // Editing the description re-debounces and refreshes the embedding.
  await page.request.patch(`/api/reimbursements/${claimId}`, {
    data: { claimDescription: "Christmas banquet decorations" },
  });
  await searchUntil(
    page,
    { query: "christmas banquet decorations", types: ["claim"] },
    (r) => [...r.groups.flatMap((g) => g.items), ...(r.best ? [r.best] : []), ...r.exact].some(
      (i) => (i as { id: string }).id === claimId
    )
  );
});

test("scopes: member cannot ask for whole-church; an approver defaults to it and can open a foreign receipt", async ({ browser }, testInfo) => {
  const suffix = `${testInfo.project.name}-r${testInfo.retry}`;
  // Alice (member) uploads a distinctive receipt.
  const alice = await (await browser.newContext()).newPage();
  await signInAs(alice, `alice-search-${suffix}@example.com`, "Alice Uploader");
  await alice.goto("/");
  await uploadReceipts(alice, [await makeReceiptFixture("projector.jpg")], "projector for VBS");
  await searchUntil(alice, { query: "projector VBS" }, anyHit);
  const receiptId = (await (await alice.request.get("/api/receipts")).json()).receipts[0].id;

  // Bob (plain member): scope-all and decided are 404 — indistinguishable.
  const bob = await (await browser.newContext()).newPage();
  await signInAs(bob, `bob-search-${suffix}@example.com`, "Bob Member");
  expect((await bob.request.post("/api/search", { data: { query: "x", scope: "all" } })).status()).toBe(404);
  expect((await bob.request.post("/api/search", { data: { query: "", scope: "decided" } })).status()).toBe(404);
  // And a member's default scope cannot see Alice's receipt.
  const bobResult = await (await bob.request.post("/api/search", { data: { query: "projector VBS" } })).json();
  expect(anyHit(bobResult)).toBe(false);
  expect((await bob.request.get(`/api/receipts/${receiptId}/file`)).status()).toBe(404);

  // Carol (approver, granted directly in the e2e DB — the verified-mirror
  // shortcut every role e2e uses): defaults to whole-church, sees the owner,
  // and the ratified §6.3 grant lets her open the image.
  const carol = await (await browser.newContext()).newPage();
  await signInAs(carol, `carol-search-${suffix}@example.com`, "Carol Approver");
  await grantRole(`carol-search-${suffix}@example.com`, "approver");
  const carolResult = await searchUntil(carol, { query: "projector VBS" }, anyHit);
  const items = [
    ...carolResult.exact,
    ...(carolResult.best ? [carolResult.best] : []),
    ...carolResult.groups.flatMap((g) => g.items),
  ] as { id: string; ownerName?: string }[];
  const hit = items.find((i) => i.id === receiptId)!;
  expect(hit).toBeTruthy();
  expect(hit.ownerName).toBe("Alice Uploader");
  expect((await carol.request.get(`/api/receipts/${receiptId}/file`)).status()).toBe(200);

  // The scope segment renders for Carol (and not for Bob).
  await carol.goto("/search");
  await expect(carol.getByTestId("search-scope-filter")).toBeVisible();
  await bob.goto("/search");
  await expect(bob.getByTestId("search-scope-filter")).toHaveCount(0);
});

test("duty pauses narrow the grant per-duty (real access, not just UI)", async ({ browser }, testInfo) => {
  const suffix = `${testInfo.project.name}-r${testInfo.retry}`;
  // A member uploads a foreign receipt the role-holders will (or won't) reach.
  const member = await (await browser.newContext()).newPage();
  const memberEmail = `dp-member-${suffix}@example.com`;
  await signInAs(member, memberEmail, "Duty Member");
  await member.goto("/");
  await uploadReceipts(member, [await makeReceiptFixture("dp.jpg")], "projector for VBS");
  await searchUntil(member, { query: "projector VBS" }, anyHit);
  const receiptId = (await (await member.request.get("/api/receipts")).json()).receipts[0].id;

  // An approver who pauses Approvals reads like a member: scope-all AND decided
  // 404, the foreign file 404, and the scope control disappears.
  const approverEmail = `dp-approver-${suffix}@example.com`;
  const approver = await (await browser.newContext()).newPage();
  await signInAs(approver, approverEmail, "Duty Approver");
  await grantRole(approverEmail, "approver");
  expect((await approver.request.post("/api/search", { data: { query: "x", scope: "all" } })).status()).toBe(200);
  expect((await approver.request.get(`/api/receipts/${receiptId}/file`)).status()).toBe(200);

  await setPauses(approverEmail, { approvalsPaused: true });
  expect((await approver.request.post("/api/search", { data: { query: "x", scope: "all" } })).status()).toBe(404);
  expect((await approver.request.post("/api/search", { data: { query: "", scope: "decided" } })).status()).toBe(404);
  expect((await approver.request.get(`/api/receipts/${receiptId}/file`)).status()).toBe(404);
  await approver.goto("/search");
  await expect(approver.getByTestId("search-scope-filter")).toHaveCount(0);

  // A treasurer who pauses ONLY Approvals keeps whole-church (Finance active)
  // but loses "Claims I decided": scope-all 200, decided 404, and the scope
  // control shows without the third segment.
  const treasurerEmail = `dp-treasurer-${suffix}@example.com`;
  const treasurer = await (await browser.newContext()).newPage();
  await signInAs(treasurer, treasurerEmail, "Duty Treasurer");
  await grantRole(treasurerEmail, "treasurer");
  await setPauses(treasurerEmail, { approvalsPaused: true });
  expect((await treasurer.request.post("/api/search", { data: { query: "x", scope: "all" } })).status()).toBe(200);
  expect((await treasurer.request.post("/api/search", { data: { query: "", scope: "decided" } })).status()).toBe(404);
  expect((await treasurer.request.get(`/api/receipts/${receiptId}/file`)).status()).toBe(200);
  await treasurer.goto("/search");
  const scope = treasurer.getByTestId("search-scope-filter");
  await expect(scope).toBeVisible();
  await expect(scope.getByRole("radio")).toHaveCount(2); // My items / Whole church, no Decided
});

test("degraded mode: embed failure still returns exact matches + the banner", async ({ page }, testInfo) => {
  await signInAs(page, `degraded-${testInfo.project.name}-r${testInfo.retry}@example.com`, "Degraded");
  await page.goto("/");
  await uploadReceipts(page, [await makeReceiptFixture("banner.jpg")], "banner paint supplies");
  await searchUntil(page, { query: "banner paint" }, anyHit);

  // __EMBED_FAIL__ makes the mock query-embed throw (§3.1) — the exact pass
  // must still deliver, with the degraded marker set.
  const res = await page.request.post("/api/search", {
    data: { query: "banner paint __EMBED_FAIL__" },
  });
  expect(res.ok()).toBe(true);
  const body = await res.json();
  expect(body.degraded).toBe("semanticUnavailable");

  await page.goto("/search");
  await page.getByTestId("search-input").fill("banner __EMBED_FAIL__");
  await page.getByTestId("search-submit").click();
  await expect(page.getByTestId("search-degraded-note")).toBeVisible();
});

test("IME safety: Enter during composition never fires a search", async ({ page }, testInfo) => {
  await signInAs(page, `ime-${testInfo.project.name}-r${testInfo.retry}@example.com`, "Ime User");
  await page.goto("/search");
  await page.getByTestId("search-input").fill("王姐妹");

  let searchCalls = 0;
  page.on("request", (req) => {
    if (req.url().includes("/api/search")) searchCalls++;
  });

  // A composing Enter (what pinyin/zhuyin IMEs send to commit the buffer).
  await page.getByTestId("search-input").evaluate((el) => {
    const e = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    Object.defineProperty(e, "isComposing", { value: true });
    el.dispatchEvent(e);
  });
  await page.waitForTimeout(400);
  expect(searchCalls).toBe(0);

  // A real Enter fires exactly one search.
  await page.getByTestId("search-input").press("Enter");
  await expect.poll(() => searchCalls).toBe(1);
});

test("admin model change wipes and rebuilds; search works on the new model", async ({ page }, testInfo) => {
  const email = `modeladmin-${testInfo.project.name}-r${testInfo.retry}@example.com`;
  await signInAs(page, email, "Model Admin");
  await grantRole(email, "admin");
  await page.goto("/");
  await uploadReceipts(page, [await makeReceiptFixture("rebuild.jpg")], "communion cups");
  await searchUntil(page, { query: "communion cups" }, anyHit);

  // Change the model (mock probe detects the dim; mock vectors are salted by
  // model name, so old vectors CANNOT satisfy the new model's queries — only
  // a real rebuild makes this pass).
  const put = await page.request.put("/api/admin/embeddings", {
    data: { model: `mock-model-b-${testInfo.retry}`, enabled: true },
  });
  expect(put.ok()).toBe(true);
  expect((await put.json()).rebuildStarted).toBe(true);

  await searchUntil(page, { query: "communion cups" }, anyHit, 45_000);
});

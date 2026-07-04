import { test, expect } from "@playwright/test";
import sharp from "sharp";
import { makeReceiptFixture, signInAs, uploadReceipts } from "./helpers";

async function storedImageMeta(page: import("@playwright/test").Page, receiptId: string) {
  const res = await page.request.get(`/api/receipts/${receiptId}/file`);
  expect(res.status()).toBe(200);
  return sharp(await res.body()).metadata();
}

test("rotate and crop a receipt image from the claim review screen", async ({ page }, testInfo) => {
  await signInAs(page, `cropper-${testInfo.project.name}@example.com`, "Cropper");
  await page.goto("/shoebox");
  await uploadReceipts(page, [await makeReceiptFixture("edit-me.jpg")]);
  await page.locator('[data-testid^="receipt-card-"]').first().click();
  await page.getByTestId("generate-claim").click();
  await page.waitForURL(/\/claims\/[^/]+$/, { timeout: 30_000 });
  const claimId = page.url().match(/claims\/([^/]+)/)![1];
  const receiptId = (await (await page.request.get(`/api/reimbursements/${claimId}`)).json())
    .reimbursement.receipts[0].receiptId;

  const before = await storedImageMeta(page, receiptId);

  // Rotate 90° clockwise through the editor dialog — stored dimensions swap.
  await page.getByTestId(`edit-image-${receiptId}`).click();
  await expect(page.getByTestId("image-editor-save")).toBeDisabled(); // nothing changed yet
  await page.getByTestId("rotate-right").click();
  await page.getByTestId("image-editor-save").click();
  await expect(page.getByTestId("image-editor-save")).toHaveCount(0); // dialog closed on save
  const rotated = await storedImageMeta(page, receiptId);
  expect(rotated.width).toBe(before.height);
  expect(rotated.height).toBe(before.width);

  // Crop the top half via the same endpoint the crop box drives.
  const cropRes = await page.request.post(`/api/receipts/${receiptId}/edit`, {
    data: { rotate: 0, crop: { left: 0, top: 0, width: 1, height: 0.5 }, reimbursementId: claimId },
  });
  expect(cropRes.status()).toBe(200);
  const cropped = await storedImageMeta(page, receiptId);
  expect(cropped.width).toBe(rotated.width);
  expect(cropped.height).toBe(Math.round(rotated.height! / 2));

  // A no-op edit is refused.
  expect(
    (await page.request.post(`/api/receipts/${receiptId}/edit`, { data: { rotate: 0 } })).status()
  ).toBe(400);

  // Both edits landed in the claim's audit trail (telemetry duty).
  const { logs } = await (
    await page.request.get(`/api/extraction-logs?reimbursementId=${claimId}`)
  ).json();
  const detail = await (await page.request.get(`/api/extraction-logs/${logs[0].id}`)).json();
  const edits = detail.auditEvents.filter(
    (e: { action: string }) => e.action === "edit-receipt-image"
  );
  expect(edits).toHaveLength(2);
  expect(edits[0].detail.rotate).toBe(90);
  expect(edits[1].detail.crop.height).toBe(0.5);

  // Once the claim is generated the receipt is processed and the image is
  // frozen with it — the packet must keep re-downloading unchanged.
  const item = detail.lineItems[0];
  await page.request.patch(`/api/line-items/${item.id}`, {
    data: { ministry: "General Fund", isVerified: true },
  });
  expect((await page.request.post(`/api/reimbursements/${claimId}/pdf`)).status()).toBe(200);
  await page.reload();
  await expect(page.getByTestId(`edit-image-${receiptId}`)).toHaveCount(0); // button gone
  expect(
    (await page.request.post(`/api/receipts/${receiptId}/edit`, { data: { rotate: 90 } })).status()
  ).toBe(409);
});

test("PDF receipts cannot be rotated or cropped", async ({ page }, testInfo) => {
  await signInAs(page, `pdfer-${testInfo.project.name}@example.com`, "Pdfer");
  const pdfBytes = Buffer.from(
    "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
      "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
      "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n" +
      "trailer<</Size 4/Root 1 0 R>>\n%%EOF"
  );
  const upload = await page.request.post("/api/receipts", {
    multipart: { files: { name: "invoice.pdf", mimeType: "application/pdf", buffer: pdfBytes } },
  });
  expect(upload.status()).toBe(201);
  const receiptId = (await upload.json()).receipts[0].id;
  const res = await page.request.post(`/api/receipts/${receiptId}/edit`, { data: { rotate: 90 } });
  expect(res.status()).toBe(400);
  expect((await res.json()).error).toMatch(/image receipts/i);
});

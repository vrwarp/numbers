import { test, expect } from "@playwright/test";
import fs from "fs/promises";
import path from "path";
import sharp from "sharp";
import { makeReceiptFixture, signInAs, uploadReceipts } from "./helpers";

/** Files stored for a receipt id anywhere under the e2e upload dir. */
async function storedFilesFor(receiptId: string): Promise<string[]> {
  const uploads = path.join(process.cwd(), ".e2e-data", "uploads");
  const entries = await fs.readdir(uploads, { recursive: true }).catch(() => [] as string[]);
  return entries.map((f) => path.basename(String(f))).filter((f) => f.startsWith(receiptId));
}

async function storedImageMeta(page: import("@playwright/test").Page, receiptId: string) {
  const res = await page.request.get(`/api/receipts/${receiptId}/file`);
  expect(res.status()).toBe(200);
  return sharp(await res.body()).metadata();
}

test("rotate and crop a receipt image from the claim review screen", async ({ page }, testInfo) => {
  await signInAs(page, `cropper-${testInfo.project.name}@example.com`, "Cropper");
  await page.goto("/");
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

  // The pristine upload was preserved on the first edit, so a reset is offered
  // even with no unsaved changes — but it takes effect only on Save.
  expect(
    (await (await page.request.get(`/api/receipts/${receiptId}/edit`)).json()).hasOriginal
  ).toBe(true);
  const edited = await storedImageMeta(page, receiptId); // current rotated+cropped file

  // Reset only STAGES the restore: the dialog stays open, Save turns on, Cancel
  // still reads "Cancel", and nothing is written to disk yet.
  await page.getByTestId(`edit-image-${receiptId}`).click();
  await expect(page.getByTestId("crop-reset")).toBeEnabled();
  await page.getByTestId("crop-reset").click();
  await expect(page.getByTestId("image-editor-save")).toBeEnabled();
  await expect(page.getByTestId("image-editor-cancel")).toHaveText("Cancel");
  const staged = await storedImageMeta(page, receiptId);
  expect(staged.width).toBe(edited.width); // stored file untouched
  expect(staged.height).toBe(edited.height);

  // Cancel discards the staged reset — the stored file is still the edited one.
  await page.getByTestId("image-editor-cancel").click();
  await expect(page.getByTestId("image-editor-save")).toHaveCount(0);
  const cancelled = await storedImageMeta(page, receiptId);
  expect(cancelled.width).toBe(edited.width);
  expect(cancelled.height).toBe(edited.height);

  // Staging the reset and Saving commits it: the stored file reverts to the
  // pristine upload's dimensions.
  await page.getByTestId(`edit-image-${receiptId}`).click();
  await page.getByTestId("crop-reset").click();
  await page.getByTestId("image-editor-save").click();
  await expect(page.getByTestId("image-editor-save")).toHaveCount(0); // dialog closed
  const restored = await storedImageMeta(page, receiptId);
  expect(restored.width).toBe(before.width);
  expect(restored.height).toBe(before.height);

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

test("the first crop is cut from the full-resolution upload, not the compressed copy", async ({
  page,
}, testInfo) => {
  await signInAs(page, `hires-${testInfo.project.name}@example.com`, "HiRes");

  // A photo well above the 1600px storage cap: 2000×2600.
  const big = await sharp({
    create: { width: 2000, height: 2600, channels: 3, background: { r: 250, g: 250, b: 245 } },
  })
    .jpeg({ quality: 90 })
    .toBuffer();
  const upload = await page.request.post("/api/receipts", {
    multipart: { files: { name: "big.jpg", mimeType: "image/jpeg", buffer: big } },
  });
  expect(upload.status()).toBe(201);
  const receiptId = (await upload.json()).receipts[0].id;

  // The working copy is compressed (long edge capped at 1600) while the
  // pristine upload sits beside it as a sidecar; the DB flag stays unset
  // until an edit actually happens, so no reset is offered yet.
  const stored = await storedImageMeta(page, receiptId);
  expect(stored.height).toBe(1600);
  expect(stored.width!).toBeLessThan(1600);
  expect((await storedFilesFor(receiptId)).sort()).toEqual([
    `${receiptId}.jpg`,
    `${receiptId}.orig.jpg`,
  ]);
  expect(
    (await (await page.request.get(`/api/receipts/${receiptId}/edit`)).json()).hasOriginal
  ).toBe(false);

  // Crop the top half. Re-derived from the 2000×2600 original, the 2000×1300
  // crop gets the full 1600px budget — cropping the stored 1231px-wide file
  // could never exceed its own width.
  const cropRes = await page.request.post(`/api/receipts/${receiptId}/edit`, {
    data: { rotate: 0, crop: { left: 0, top: 0, width: 1, height: 0.5 } },
  });
  expect(cropRes.status()).toBe(200);
  const cropped = await storedImageMeta(page, receiptId);
  expect(cropped.width).toBe(1600);
  expect(cropped.height).toBe(1040);

  // The upload-time sidecar now backs the reset; restoring re-compresses the
  // pristine upload back to the original working dimensions.
  expect(
    (await (await page.request.get(`/api/receipts/${receiptId}/edit`)).json()).hasOriginal
  ).toBe(true);
  expect(
    (await page.request.post(`/api/receipts/${receiptId}/edit`, { data: { restore: true } })).status()
  ).toBe(200);
  const restored = await storedImageMeta(page, receiptId);
  expect(restored.width).toBe(stored.width);
  expect(restored.height).toBe(stored.height);

  // Deleting the receipt removes the working file AND the sidecar.
  expect((await page.request.delete(`/api/receipts/${receiptId}`)).status()).toBe(200);
  expect(await storedFilesFor(receiptId)).toEqual([]);
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

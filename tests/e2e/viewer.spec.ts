import { test, expect } from "@playwright/test";
import sharp from "sharp";
import { makeReceiptFixture, signInAs, uploadReceipts } from "./helpers";

// The zoomable full-screen receipt viewer, opened from each Shoebox card.
test("receipt viewer opens, zooms, and closes without selecting the card", async ({
  page,
}, testInfo) => {
  page.on("dialog", (d) => d.accept());
  await page.goto("/signin");
  await signInAs(page, `viewer-${testInfo.project.name}@example.com`, "Zoom Tester");

  await page.goto("/shoebox");
  await uploadReceipts(page, [await makeReceiptFixture("costco.jpg")]);

  // The expand button sits in the bottom-right of the thumbnail.
  const viewBtn = page.locator('[data-testid^="receipt-view-"]').first();
  await expect(viewBtn).toBeVisible();
  await viewBtn.click();

  const viewer = page.getByTestId("receipt-viewer");
  await expect(viewer).toBeVisible();
  await expect(page.getByText("100%")).toBeVisible();

  // Zoom in twice (1.4x each) → 196%.
  const zoomIn = page.getByRole("button", { name: "Zoom in" });
  await zoomIn.click();
  await zoomIn.click();
  await expect(page.getByText("196%")).toBeVisible();

  // Reset returns to 100%.
  await page.getByRole("button", { name: "Reset zoom" }).click();
  await expect(page.getByText("100%")).toBeVisible();

  await page.getByTestId("receipt-viewer-close").click();
  await expect(viewer).toHaveCount(0);

  // Opening the viewer must not have toggled the card's selection.
  await expect(page.getByText(/receipt.*selected/i)).toHaveCount(0);
});

test("receipt viewer can rotate/crop an image, and hides the tool for PDFs", async ({
  page,
}, testInfo) => {
  await signInAs(page, `viewer-edit-${testInfo.project.name}@example.com`, "Editor");
  await page.goto("/shoebox");
  await uploadReceipts(page, [await makeReceiptFixture("edit-me.jpg")]);

  const receiptId = (await (await page.request.get("/api/receipts")).json()).receipts[0].id;
  const before = await sharp(
    await (await page.request.get(`/api/receipts/${receiptId}/file`)).body(),
  ).metadata();

  await page.locator('[data-testid^="receipt-view-"]').first().click();
  await expect(page.getByTestId("receipt-viewer")).toBeVisible();

  // Rotate 90° through the editor launched from the viewer's top bar.
  await page.getByTestId("receipt-viewer-edit").click();
  await expect(page.getByTestId("image-editor-stage")).toBeVisible();
  await page.getByTestId("rotate-right").click();
  await page.getByTestId("image-editor-save").click();
  await expect(page.getByTestId("image-editor-save")).toHaveCount(0);

  // Stored dimensions swapped, and the viewer stays open on the edited image.
  await expect(page.getByTestId("receipt-viewer")).toBeVisible();
  const after = await sharp(
    await (await page.request.get(`/api/receipts/${receiptId}/file`)).body(),
  ).metadata();
  expect(after.width).toBe(before.height);
  expect(after.height).toBe(before.width);

  // PDFs open in the viewer but expose no rotate/crop tool.
  const pdfBytes = Buffer.from(
    "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
      "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
      "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n" +
      "trailer<</Size 4/Root 1 0 R>>\n%%EOF",
  );
  await page.request.post("/api/receipts", {
    multipart: { files: { name: "invoice.pdf", mimeType: "application/pdf", buffer: pdfBytes } },
  });
  await page.reload();
  const pdfCard = page.locator('[data-testid^="receipt-card-"]', { hasText: "invoice.pdf" });
  await pdfCard.locator('[data-testid^="receipt-view-"]').click();
  await expect(page.getByTestId("receipt-viewer")).toBeVisible();
  await expect(page.getByTestId("receipt-viewer-edit")).toHaveCount(0);
});

import { test, expect } from "@playwright/test";
import { makePdfFixture, signInAs, uploadReceipts } from "./helpers";

// A PDF receipt must show a real inline preview image on the review screen —
// mobile browsers (e.g. Chrome on Android) render an embedded <object>/<iframe>
// PDF as a blank box, so we serve a server-rasterized JPEG instead.
test("PDF receipt shows an inline raster preview on the review screen", async ({
  page,
}, testInfo) => {
  page.on("dialog", (d) => d.accept());
  await signInAs(page, `pdf-${testInfo.project.name}@example.com`, "PDF Tester");

  await page.goto("/");
  await uploadReceipts(page, [await makePdfFixture("invoice.pdf", { pages: 2 })]);

  // Batch the single receipt into a claim and open the review screen.
  await page.locator('[data-testid^="receipt-card-"]').first().click();
  await page.getByTestId("generate-claim").click();
  await page.waitForURL(/\/claims\/[^/]+$/, { timeout: 30_000 });

  // The review card renders the preview <img>, and it actually decodes (the
  // /preview route rasterized the PDF) rather than sitting broken/blank.
  const preview = page.locator('img[data-testid^="pdf-preview-"]').first();
  await expect(preview).toBeVisible();
  await expect
    .poll(() => preview.evaluate((el: HTMLImageElement) => el.naturalWidth), { timeout: 15_000 })
    .toBeGreaterThan(0);

  // The original PDF is still one click away.
  await expect(page.getByRole("link", { name: /Open PDF receipt/ })).toBeVisible();
});

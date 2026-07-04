import { test, expect } from "@playwright/test";
import fs from "fs/promises";
import { makeReceiptFixture, signInAs } from "./helpers";

// Building a DataTransfer with a real File lets us drive the browser's native
// drag-and-drop the same way a desktop file drop would.
async function fileDataTransfer(page: import("@playwright/test").Page, filePath: string) {
  const buffer = await fs.readFile(filePath);
  const name = filePath.split("/").pop()!;
  return page.evaluateHandle(
    ({ base64, name }) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], name, { type: "image/jpeg" }));
      return dt;
    },
    { base64: buffer.toString("base64"), name }
  );
}

test("the shoebox is a whole-page drag-and-drop upload target", async ({ page }, testInfo) => {
  await signInAs(page, `dropper-${testInfo.project.name}-r${testInfo.retry}@example.com`, "Dan Dropper");

  const dropzone = page.getByTestId("shoebox-dropzone");
  const dataTransfer = await fileDataTransfer(page, await makeReceiptFixture("costco.jpg"));

  // Dragging a file over the page reveals the drop overlay…
  await dropzone.dispatchEvent("dragenter", { dataTransfer });
  await expect(page.getByTestId("shoebox-drop-overlay")).toBeVisible();

  // …and dropping opens the prepare step; dismissing it uploads the receipt.
  await dropzone.dispatchEvent("drop", { dataTransfer });
  await expect(page.getByTestId("shoebox-drop-overlay")).toBeHidden();
  await expect(page.getByTestId("upload-note")).toBeVisible();
  await page.getByTestId("upload-note-cancel").click();
  await expect(page.locator('[data-testid^="receipt-card-"]')).toHaveCount(1, { timeout: 20_000 });
});

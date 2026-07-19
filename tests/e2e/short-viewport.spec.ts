import { test, expect, Page } from "@playwright/test";
import { makeReceiptFixture, signInAs, uploadReceipts } from "./helpers";

/**
 * Limited-height guardrail (docs/MOBILE_LIMITED_HEIGHT_UX.md). Runs under the
 * `chromium-short` project on a landscape phone (415px tall → the `short:`
 * variant is active); portrait-keyboard cases re-narrow to 390×460. These
 * assert the interaction blockers this audit fixed can't silently regress:
 * nothing important renders under a fixed bar, and dialog footers stay in reach.
 */

const KEYBOARD = { width: 390, height: 460 };

/**
 * True when the element's own centre point is the topmost hit target there —
 * i.e. it is on-screen AND not covered by a fixed bar/overlay. toBeVisible()
 * alone misses occlusion, which is exactly the failure mode we're guarding.
 */
async function centreIsHittable(page: Page, testId: string) {
  return page.evaluate((id) => {
    const el = document.querySelector(`[data-testid="${id}"]`);
    if (!el) return { ok: false, reason: "not found" };
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return { ok: false, reason: "zero-size" };
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    if (cy < 0 || cy > window.innerHeight || cx < 0 || cx > window.innerWidth) {
      return { ok: false, reason: "outside-viewport" };
    }
    const top = document.elementFromPoint(cx, cy);
    return { ok: !!top && el.contains(top), reason: top ? (top as HTMLElement).tagName : "nothing" };
  }, testId);
}

async function newSingleReceiptClaim(page: Page) {
  await page.goto("/");
  await uploadReceipts(page, [await makeReceiptFixture("costco.jpg")]);
  await page.locator('[data-testid^="receipt-card-"]').first().click();
  await page.getByTestId("generate-claim").click();
  await page.waitForURL(/\/claims\/[^/]+$/, { timeout: 30_000 });
}

test("split editor opens clear of the action bar", async ({ page }, testInfo) => {
  page.on("dialog", (d) => d.accept());
  await signInAs(page, `short-split-${testInfo.project.name}-r${testInfo.retry}@example.com`, "Shorty");
  await newSingleReceiptClaim(page);

  // Open the inline split editor on the only row.
  await page.getByTitle("Split into two rows").first().click();

  // The amount input and Confirm are on-screen…
  await expect(page.getByTestId("split-amount")).toBeVisible();
  await expect(page.getByTestId("split-confirm")).toBeVisible();

  // …the floating action bar is suppressed while the editor is open…
  await expect(page.getByTestId("claim-action-bar")).toBeHidden();

  // …and the amount input is genuinely un-occluded (the original blocker: it
  // rendered underneath the sticky bar).
  const hit = await centreIsHittable(page, "split-amount");
  expect(hit.ok, `split-amount centre covered by ${hit.reason}`).toBe(true);
});

test("upload-note dialog keeps its note field and Save reachable at keyboard height", async ({
  page,
}, testInfo) => {
  await signInAs(page, `short-note-${testInfo.project.name}-r${testInfo.retry}@example.com`, "Shorty");
  await page.setViewportSize(KEYBOARD);
  await page.goto("/");

  await page.getByTestId("file-input").setInputFiles([await makeReceiptFixture("costco.jpg")]);

  // The dialog is named for its note field; both it and Save must be reachable
  // without hunting past the photo editor.
  await expect(page.getByTestId("upload-note")).toBeVisible();
  await expect(page.getByTestId("upload-note-confirm")).toBeVisible();
  const noteHit = await centreIsHittable(page, "upload-note");
  expect(noteHit.ok, `upload-note covered by ${noteHit.reason}`).toBe(true);
  const saveHit = await centreIsHittable(page, "upload-note-confirm");
  expect(saveHit.ok, `Save covered by ${saveHit.reason}`).toBe(true);
});

test("profile Save stays pinned in reach with a field focused", async ({ page }, testInfo) => {
  await signInAs(page, `short-profile-${testInfo.project.name}-r${testInfo.retry}@example.com`, "Shorty");
  await page.setViewportSize(KEYBOARD);
  await page.goto("/profile");

  // Focusing the address is what would push Save below the fold pre-fix.
  await page.getByTestId("profile-address").click();
  await expect(page.getByTestId("profile-save")).toBeVisible();
  const hit = await centreIsHittable(page, "profile-save");
  expect(hit.ok, `profile Save covered by ${hit.reason}`).toBe(true);
});

const navPosition = (page: Page) =>
  page.evaluate(() => getComputedStyle(document.querySelector("header")!).position);

test("nav only reconfigures for a genuine landscape phone, not a keyboard-shrunk portrait", async ({
  page,
}, testInfo) => {
  await signInAs(page, `short-nav-${testInfo.project.name}-r${testInfo.retry}@example.com`, "Shorty");

  // A portrait phone whose viewport shrank because the keyboard opened is short
  // but narrow: the nav must stay put (it's `short-wide:`, min-width 640), so
  // focusing a field never jars the chrome around.
  await page.setViewportSize({ width: 412, height: 430 });
  expect(await navPosition(page), "nav should stay sticky on keyboard-shrunk portrait").toBe(
    "sticky"
  );

  // A genuine landscape phone (wide + short) un-sticks the nav to reclaim height.
  await page.setViewportSize({ width: 880, height: 390 });
  expect(await navPosition(page), "nav should un-stick on a landscape phone").toBe("static");
});

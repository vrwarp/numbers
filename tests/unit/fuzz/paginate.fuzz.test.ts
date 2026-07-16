import { describe, expect } from "vitest";
import { paginateItems } from "@/lib/pdf/paginate";
import { fuzz } from "./prng";

/**
 * The PDF form pagination decides which rows land on which physical page of
 * the official form — an off-by-one here silently drops or duplicates money
 * rows. These properties pin the exact partition semantics.
 */
describe("paginateItems fuzz", () => {
  fuzz("pages concatenate back to the original items in order", { iters: 400 }, (rng) => {
    const items = rng.array(rng.int(0, 200), (_, i) => i);
    const rowsPerPage = rng.int(1, 20);
    const pages = paginateItems(items, rowsPerPage);
    expect(pages.flat()).toEqual(items);
  });

  fuzz("no page exceeds rowsPerPage and only the last may be short", { iters: 400 }, (rng) => {
    const items = rng.array(rng.int(1, 200), (_, i) => i);
    const rowsPerPage = rng.int(1, 20);
    const pages = paginateItems(items, rowsPerPage);
    for (const [i, page] of pages.entries()) {
      expect(page.length).toBeGreaterThan(0);
      expect(page.length).toBeLessThanOrEqual(rowsPerPage);
      if (i < pages.length - 1) expect(page.length).toBe(rowsPerPage);
    }
    expect(pages.length).toBe(Math.ceil(items.length / rowsPerPage));
  });

  fuzz("exact multiples never produce a trailing empty page", { iters: 200 }, (rng) => {
    const rowsPerPage = rng.int(1, 15);
    const pagesWanted = rng.int(1, 12);
    const items = rng.array(rowsPerPage * pagesWanted, (_, i) => i);
    const pages = paginateItems(items, rowsPerPage);
    expect(pages.length).toBe(pagesWanted);
    expect(pages.at(-1)!.length).toBe(rowsPerPage);
  });

  fuzz("empty input yields exactly one empty page", { iters: 20 }, (rng) => {
    expect(paginateItems([], rng.int(1, 20))).toEqual([[]]);
  });

  fuzz("invalid rowsPerPage always throws", { iters: 100 }, (rng) => {
    const bad = rng.pick([0, -1, -rng.int(1, 100)]);
    expect(() => paginateItems([1, 2, 3], bad)).toThrow();
  });
});

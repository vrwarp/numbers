import { describe, expect, it } from "vitest";
import { paginateItems } from "@/lib/pdf/paginate";
import { FORM_ROWS_PER_PAGE } from "@/lib/config";

const items = (n: number) => Array.from({ length: n }, (_, i) => i);

describe("paginateItems", () => {
  it("matches the official form's 13-row table", () => {
    expect(FORM_ROWS_PER_PAGE).toBe(13);
  });

  it("puts up to 13 items on a single page", () => {
    expect(paginateItems(items(1))).toHaveLength(1);
    expect(paginateItems(items(13))).toHaveLength(1);
    expect(paginateItems(items(13))[0]).toHaveLength(13);
  });

  it("splits 14 items across two pages", () => {
    const pages = paginateItems(items(14));
    expect(pages).toHaveLength(2);
    expect(pages[0]).toHaveLength(13);
    expect(pages[1]).toHaveLength(1);
  });

  it("splits 15 items across two pages (blueprint example)", () => {
    const pages = paginateItems(items(15));
    expect(pages).toHaveLength(2);
    expect(pages[1]).toHaveLength(2);
  });

  it("splits 27 items across three pages", () => {
    expect(paginateItems(items(27))).toHaveLength(3);
  });

  it("preserves item order across pages", () => {
    const pages = paginateItems(items(30));
    expect(pages.flat()).toEqual(items(30));
  });

  it("returns one empty page for zero items", () => {
    expect(paginateItems([])).toEqual([[]]);
  });

  it("honors a custom page size and rejects invalid ones", () => {
    expect(paginateItems(items(10), 5)).toHaveLength(2);
    expect(() => paginateItems(items(3), 0)).toThrow();
  });
});

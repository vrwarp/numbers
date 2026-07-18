import { FORM_ROWS_PER_PAGE } from "@/lib/config";

/**
 * Split line items into form pages. The official CFCC form fits 13 rows
 * (large-row variants fewer — the caller passes their capacity), so a claim
 * with more items produces multiple form pages; the grand total appears on
 * the final page, earlier pages showing "(continued)".
 */
export function paginateItems<T>(items: T[], rowsPerPage: number = FORM_ROWS_PER_PAGE): T[][] {
  if (rowsPerPage < 1) throw new Error("rowsPerPage must be >= 1");
  if (items.length === 0) return [[]];
  const pages: T[][] = [];
  for (let i = 0; i < items.length; i += rowsPerPage) {
    pages.push(items.slice(i, i + rowsPerPage));
  }
  return pages;
}

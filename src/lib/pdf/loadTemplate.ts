import fs from "fs/promises";
import path from "path";
import { configValue } from "../config-file";
import { FORM_ROWS_PER_PAGE } from "@/lib/config";

/**
 * Load the blank CFCC AcroForm template. The official form ships with the app
 * at assets/cfcc-form-template.pdf; a church can point TEMPLATE_PDF at a
 * replacement (it must use the same field names).
 */
export async function loadTemplateBytes(): Promise<Uint8Array> {
  const configured = configValue("TEMPLATE_PDF");
  if (configured) {
    try {
      return new Uint8Array(await fs.readFile(configured));
    } catch {
      console.warn(`TEMPLATE_PDF=${configured} could not be read; using bundled form`);
    }
  }
  return bundledBytes("cfcc-form-template.pdf");
}

/**
 * Row capacity of the template packet generation should fill for a claim with
 * `activeRows` line items: the smallest large-row legibility variant
 * (scripts/make-row-variants.mjs) the whole claim fits on, else the official
 * 13-row form. Every variant capacity is ≤ FORM_ROWS_PER_PAGE, so a claim
 * that fits one always fits ONE page — a packet's form-page count stays
 * exactly ceil(activeRows/FORM_ROWS_PER_PAGE), the derivation the
 * print/certificate/approved-packet routes use on stored packets, for every
 * claim size. Keep that property (all rows ≤ 13) when changing the rule.
 */
export const VARIANT_ROW_OPTIONS = [5, 9] as const;

export function variantRowsFor(activeRows: number): number {
  for (const rows of VARIANT_ROW_OPTIONS) {
    if (activeRows >= 1 && activeRows <= rows) return rows;
  }
  return FORM_ROWS_PER_PAGE;
}

/**
 * The template to fill for a claim with `activeRows` items, plus its row
 * capacity for pagination. A configured TEMPLATE_PDF (a church's custom form,
 * which has no variants) disables auto-picking and always wins.
 */
export async function loadTemplateForRows(
  activeRows: number
): Promise<{ bytes: Uint8Array; rowsPerPage: number }> {
  const rows = variantRowsFor(activeRows);
  if (configValue("TEMPLATE_PDF") || rows === FORM_ROWS_PER_PAGE) {
    return { bytes: await loadTemplateBytes(), rowsPerPage: FORM_ROWS_PER_PAGE };
  }
  try {
    return { bytes: await bundledBytes(`cfcc-form-template-${rows}row.pdf`), rowsPerPage: rows };
  } catch {
    console.warn(`bundled ${rows}-row template variant missing; using official form`);
    return { bytes: await loadTemplateBytes(), rowsPerPage: FORM_ROWS_PER_PAGE };
  }
}

async function bundledBytes(name: string): Promise<Uint8Array> {
  return new Uint8Array(await fs.readFile(path.join(process.cwd(), "assets", name)));
}

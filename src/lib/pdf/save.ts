import type { PDFDocument } from "pdf-lib";
import { tagUntypedFormXObjects } from "./printsafe";

/**
 * Save options for every PDF that leaves the app for a human — or a printer.
 *
 * pdf-lib defaults to `useObjectStreams: true`, which packs the catalog, the
 * page tree and every font dictionary into compressed object streams behind a
 * cross-reference STREAM (the PDF 1.5 structures). Desktop viewers all handle
 * that, but the interpreter that actually rasterizes the job often does not:
 * Android's Mopria / Default Print Service hands the raw bytes to any printer
 * that advertises `application/pdf`, and printer firmware stuck on the classic
 * xref table cannot even locate the page objects — the job dies, spools
 * forever, or comes out blank. Same story for a handful of older desktop
 * readers (pdf-lib#1224).
 *
 * Writing a plain xref table costs ~20% in file size (page content streams
 * stay Flate-compressed) and makes the packet parseable by anything that has
 * ever read a PDF. Printability beats bytes for a form whose whole purpose is
 * to be printed and signed.
 */
export const PRINT_SAFE_SAVE = { useObjectStreams: false } as const;

/**
 * `doc.save()` with the print-compatibility options above, after the
 * structural repairs in ./printsafe. Every PDF the app hands out goes through
 * here, so a new assembly route cannot forget them — including routes that
 * re-emit pages copied out of packets generated before those repairs existed.
 */
export function savePrintable(doc: PDFDocument): Promise<Uint8Array> {
  tagUntypedFormXObjects(doc);
  return doc.save(PRINT_SAFE_SAVE);
}

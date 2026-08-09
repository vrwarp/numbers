import {
  PDFArray,
  PDFBool,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFPage,
  PDFRawStream,
  PDFRef,
  decodePDFRawStream,
} from "pdf-lib";

/**
 * Repairs that make a page safe for a printer's PDF interpreter. Everything
 * here is a no-op for a viewer — these are constructs desktop renderers shrug
 * off and embedded RIPs stall on.
 */

/**
 * Declare `/Subtype /Form` on XObjects that a page draws but never types.
 *
 * `form.flatten()` promotes each field's appearance stream to a page XObject.
 * pdf-lib stamps the required keys on appearances it generated itself, but
 * fields we never touched keep the TEMPLATE's own appearance stream verbatim —
 * and four of the CFCC form's are missing `/Type /XObject` and
 * `/Subtype /Form` entirely (they carry only `/BBox` and `/Resources`). The
 * flattened page then executes `Do` on an XObject whose kind is undeclared,
 * which the spec does not define: Pdfium, MuPDF and Ghostscript all guess
 * "form" and move on, but a printer RIP has no obligation to, and this is the
 * only page in a packet that carries them.
 *
 * A `/BBox` with no `/Width`/`/Height` is a form XObject and nothing else, so
 * the repair is unambiguous. Returns the number of XObjects repaired.
 */
export function tagUntypedFormXObjects(doc: PDFDocument): number {
  let repaired = 0;
  for (const page of doc.getPages()) {
    const xobjects = page.node.Resources()?.lookupMaybe(PDFName.of("XObject"), PDFDict);
    if (!xobjects) continue;
    for (const [name] of xobjects.entries()) {
      const xobject = xobjects.lookup(name);
      if (!(xobject instanceof PDFRawStream)) continue;
      const dict = xobject.dict;
      if (dict.has(PDFName.of("Subtype")) || !dict.has(PDFName.of("BBox"))) continue;
      if (dict.has(PDFName.of("Width")) || dict.has(PDFName.of("Height"))) continue;
      dict.set(PDFName.of("Type"), PDFName.of("XObject"));
      dict.set(PDFName.of("Subtype"), PDFName.of("Form"));
      if (!dict.has(PDFName.of("FormType"))) dict.set(PDFName.of("FormType"), PDFNumber.of(1));
      repaired += 1;
    }
  }
  return repaired;
}

/**
 * Flatten Word-style stencil SHADING PATTERNS into the equivalent flat tint.
 *
 * Word (and every other office suite) exports a shaded table cell as a
 * PaintType-1 tiling pattern whose tile paints a tiny 1-bit ImageMask — the
 * dither that makes the grey. On the CFCC form the "For Treasurer use only"
 * band is one such fill: a 1.92pt tile over a 472×38pt rect, so the consumer
 * has to instantiate the tile — decode and paint an 8×8 stencil — about 4,900
 * times for that one band. Desktop renderers cache the tile and shrug. Printer
 * firmware frequently does not, and the job stalls on the form page while the
 * receipt pages behind it sail through. (Ghostscript also reports the church's
 * pattern object as malformed — "object lacks a required Subtype" — so a
 * strict RIP may be running error recovery on all 4,900 of them.)
 *
 * A flat tint of the same ink coverage is a faithful substitution: printers
 * halftone a grey fill themselves, so the band comes out looking the same for
 * one `re f` instead of thousands of stencil tiles.
 *
 * Deliberately narrow — a pattern is rewritten only when it is unambiguously
 * one of these dither fills (PaintType 1, a single ImageMask draw, nothing
 * else that marks the page) AND the fill is written in the canonical
 * `/Pattern cs /Pn scn` form. Anything else is left exactly as authored, so a
 * church whose custom TEMPLATE_PDF uses patterns for something real keeps
 * them. Returns the number of pages rewritten.
 */
export function flattenStencilShading(doc: PDFDocument): number {
  let rewritten = 0;
  for (const page of doc.getPages()) {
    const patterns = page.node.Resources()?.lookupMaybe(PDFName.of("Pattern"), PDFDict);
    if (!patterns) continue;

    const grays = new Map<string, number>();
    for (const [name] of patterns.entries()) {
      const pattern = patterns.lookup(name);
      const gray = pattern instanceof PDFRawStream ? stencilPatternGray(pattern) : null;
      if (gray !== null) grays.set(name.asString(), gray);
    }
    if (grays.size === 0) continue;
    const substituted = rewritePageContent(page, grays);
    if (substituted.size === 0) continue;

    // Drop the now-unpainted patterns from the page's resources. Leaving them
    // costs nothing to render, but the church's pattern object is malformed
    // (Ghostscript: "object lacks a required Subtype") and a strict RIP that
    // walks the resource dictionary at page setup should never meet it.
    for (const [name] of patterns.entries()) {
      if (substituted.has(name.asString())) patterns.delete(name);
    }
    if (patterns.entries().length === 0) page.node.Resources()?.delete(PDFName.of("Pattern"));
    rewritten += 1;
  }
  return rewritten;
}

/**
 * The grey a stencil-dither pattern averages out to, or null if the pattern is
 * anything other than "clear the tile, then stamp one ImageMask in black".
 */
function stencilPatternGray(pattern: PDFRawStream): number | null {
  if (pattern.dict.lookupMaybe(PDFName.of("PaintType"), PDFNumber)?.asNumber() === 2) return null;

  const content = Buffer.from(decodePDFRawStream(pattern).decode()).toString("latin1");
  // Exactly one image draw, and nothing else that marks the tile: no text, no
  // shading, no strokes, no clipping.
  if ((content.match(/\bDo\b/g) ?? []).length !== 1) return null;
  if (/\b(BT|sh|S|s|B\*?|b\*?|W\*?)\b/.test(content)) return null;

  const xobjects = pattern.dict
    .lookupMaybe(PDFName.of("Resources"), PDFDict)
    ?.lookupMaybe(PDFName.of("XObject"), PDFDict);
  const names = xobjects ? [...xobjects.entries()].map(([name]) => name) : [];
  if (names.length !== 1) return null;
  const image = xobjects!.lookup(names[0]);
  if (!(image instanceof PDFRawStream)) return null;
  if (image.dict.lookupMaybe(PDFName.of("ImageMask"), PDFBool)?.asBoolean() !== true) return null;

  const width = image.dict.lookupMaybe(PDFName.of("Width"), PDFNumber)?.asNumber() ?? 0;
  const height = image.dict.lookupMaybe(PDFName.of("Height"), PDFNumber)?.asNumber() ?? 0;
  if (width < 1 || height < 1) return null;

  const bits = Buffer.from(decodePDFRawStream(image).decode());
  // An ImageMask sample of 0 paints and 1 leaves the ground showing, swapped
  // by /Decode [1 0]. Rows are byte-aligned, so skip the padding bits.
  const inverted =
    image.dict.lookupMaybe(PDFName.of("Decode"), PDFArray)?.lookupMaybe(0, PDFNumber)?.asNumber() === 1;
  const bytesPerRow = Math.ceil(width / 8);
  if (bits.length < bytesPerRow * height) return null;
  let painted = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const bit = (bits[y * bytesPerRow + (x >> 3)] >> (7 - (x % 8))) & 1;
      if ((bit === 0) !== inverted) painted += 1;
    }
  }
  // Black ink over a white tile: coverage 0 → white, coverage 1 → black.
  return 1 - painted / (width * height);
}

/**
 * Swap `/Pattern cs /Pn scn` for `<gray> g` in a page's content streams.
 * Returns the pattern names actually substituted — empty when the fill is not
 * written in that canonical form, since the rewrite has to be certain to be
 * safe. A name is reported only if NO reference to it survives anywhere in the
 * page, so the caller can retire it from the resources.
 */
function rewritePageContent(page: PDFPage, grays: Map<string, number>): Set<string> {
  const contents = page.node.Contents();
  const refs = (
    contents instanceof PDFArray ? contents.asArray() : [page.node.get(PDFName.of("Contents"))]
  ).filter((ref): ref is PDFRef => ref instanceof PDFRef);

  const substituted = new Set<string>();
  const rewritten: string[] = [];
  for (const ref of refs) {
    const stream = page.doc.context.lookup(ref);
    if (!(stream instanceof PDFRawStream)) continue;
    const before = Buffer.from(decodePDFRawStream(stream).decode()).toString("latin1");
    const after = before.replace(
      // The name key is PDFName.asString(), i.e. slash-included ("/P0").
      /\/Pattern\s+(cs|CS)\s*(\/[^\s/[\]<>(){}]+)\s+(scn|SCN)/g,
      (whole, cs: string, name: string, scn: string) => {
        const gray = grays.get(name);
        if (gray === undefined) return whole;
        substituted.add(name);
        // `g`/`G` take one operand and select DeviceGray — exactly a flat tint.
        return `${gray.toFixed(4)} ${cs === "cs" && scn === "scn" ? "g" : "G"}`;
      }
    );
    rewritten.push(after);
    if (after === before) continue;
    page.doc.context.assign(ref, page.doc.context.flateStream(Buffer.from(after, "latin1")));
  }

  const remaining = rewritten.join("\n");
  for (const name of [...substituted]) {
    if (new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+(scn|SCN)`).test(remaining)) {
      substituted.delete(name);
    }
  }
  return substituted;
}

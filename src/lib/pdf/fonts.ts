import fs from "fs/promises";
import path from "path";
import { EventEmitter } from "events";
import * as fontkit from "fontkit";
import type { PDFDocument, PDFFont } from "pdf-lib";
import { configValue } from "../config-file";

/**
 * CJK-capable font support for the generated claim packet.
 *
 * The form template's own text stays Helvetica (Standard-14, WinAnsi-only),
 * but user data — descriptions, ministry names, requester names, receipt
 * notes — can be Chinese. Those values are drawn with the bundled pan-CJK
 * Noto face below, embedded as a subset (a filled form grows by the glyphs it
 * uses, tens of KB, not the 16 MB font file).
 *
 * pdf-lib's companion @pdf-lib/fontkit mangles CJK-scale fonts when
 * subsetting (glyphs silently drop — both its CFF and TTF paths). Upstream
 * fontkit 2.x subsets them correctly but renamed Subset.encodeStream() to
 * encode(); `pdfLibFontkit` bridges that one call so pdf-lib can use modern
 * fontkit unchanged.
 */

const CJK_FONT_FILE = path.join("assets", "fonts", "NotoSansCJKtc-Regular.otf");

const pdfLibFontkit = {
  create(bytes: Uint8Array, postscriptName?: string) {
    // Bridging two libraries' private font interfaces — typed as any on purpose.
    const font = fontkit.create(Buffer.from(bytes), postscriptName) as any;
    const createSubset = font.createSubset.bind(font);
    font.createSubset = () => {
      const subset = createSubset();
      subset.encodeStream = () => {
        const stream = new EventEmitter();
        queueMicrotask(() => {
          try {
            stream.emit("data", subset.encode());
            stream.emit("end");
          } catch (err) {
            stream.emit("error", err);
          }
        });
        return stream;
      };
      return subset;
    };
    return font;
  },
};

let cachedFontBytes: Uint8Array | null = null;

/** Bundled pan-CJK face (CJK_FONT_PATH overrides, mirroring TEMPLATE_PDF). */
async function cjkFontBytes(): Promise<Uint8Array> {
  if (cachedFontBytes) return cachedFontBytes;
  const configured = configValue("CJK_FONT_PATH");
  if (configured) {
    try {
      cachedFontBytes = new Uint8Array(await fs.readFile(configured));
      return cachedFontBytes;
    } catch {
      console.warn(`CJK_FONT_PATH=${configured} could not be read; using bundled font`);
    }
  }
  cachedFontBytes = new Uint8Array(await fs.readFile(path.join(process.cwd(), CJK_FONT_FILE)));
  return cachedFontBytes;
}

/**
 * Embed the CJK face into `doc` as a subset. Call at most once per document
 * (generate.ts memoizes) — each call embeds a fresh subset.
 */
export async function embedCjkFont(doc: PDFDocument): Promise<PDFFont> {
  doc.registerFontkit(pdfLibFontkit as unknown as Parameters<PDFDocument["registerFontkit"]>[0]);
  return doc.embedFont(await cjkFontBytes(), { subset: true });
}

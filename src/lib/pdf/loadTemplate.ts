import fs from "fs/promises";
import path from "path";
import { configValue } from "../config-file";

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
  const bundled = path.join(process.cwd(), "assets", "cfcc-form-template.pdf");
  return new Uint8Array(await fs.readFile(bundled));
}

import fs from "fs";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

const [,, input, prefix] = process.argv;
const data = new Uint8Array(fs.readFileSync(input));
const doc = await pdfjs.getDocument({ data, verbosity: 0 }).promise;
for (let i = 1; i <= doc.numPages; i++) {
  const page = await doc.getPage(i);
  const viewport = page.getViewport({ scale: 1.6 });
  const canvasFactory = doc.canvasFactory;
  const { canvas, context } = canvasFactory.create(viewport.width, viewport.height);
  await page.render({ canvasContext: context, viewport }).promise;
  fs.writeFileSync(`${prefix}-p${i}.png`, canvas.toBuffer("image/png"));
  console.log(`wrote ${prefix}-p${i}.png`);
}

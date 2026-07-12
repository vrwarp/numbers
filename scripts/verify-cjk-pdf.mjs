// Visual check for the P0 CJK path: run the REAL generateClaimPdf (including
// copyPages + receipt append) with Chinese content, then rasterize with
// scripts/render-pdf.mjs and eyeball the PNGs.
import { readFile, writeFile } from "node:fs/promises";
import sharp from "sharp";

const { generateClaimPdf } = await import("../src/lib/pdf/generate.ts");

const templateBytes = new Uint8Array(await readFile("assets/cfcc-form-template.pdf"));
const receipt = await sharp({
  create: { width: 600, height: 900, channels: 3, background: { r: 255, g: 255, b: 250 } },
})
  .jpeg()
  .toBuffer();

const bytes = await generateClaimPdf({
  requesterName: "陳恩典 Grace Chen",
  requesterAddress: "123 Main St, San Jose, CA 95110",
  dateString: "07/11/2026",
  items: [
    {
      description: "大華超市 06/28 — 燒臘, 青菜豆腐外帶餐盒紙巾雞蛋牛奶麵包飲料零食糖果, rice",
      amountCents: 10210,
      ministry: "450 Joshua Fellowship - Mandarin",
    },
    { description: "简体测试：办公用品（打印纸、订书钉）", amountCents: 2500, ministry: "中文事工 — 退修會" },
    { description: "Costco Wholesale 06/21 — paper towels", amountCents: 9000, ministry: "237 Office Supplies" },
  ],
  receipts: [
    { data: receipt, mimeType: "image/jpeg", originalName: "ranch99.jpg", note: "退修會食物 retreat food" },
  ],
  templateBytes,
  selfLinkUrl: "https://numbers.example.org/c/testtoken123",
});
await writeFile("screenshots/verify-cjk.pdf", bytes);
console.log("saved screenshots/verify-cjk.pdf", bytes.length, "bytes");

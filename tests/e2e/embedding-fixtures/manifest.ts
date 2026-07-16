/**
 * Fixture manifest for RECORDED-REAL-EMBEDDING e2e tests
 * (docs/SEARCH_DESIGN.md §11, docs/agent/TESTING.md "Recorded embeddings").
 *
 * `npm run record:embeddings` renders these receipts (Chromium — reliable CJK),
 * sends every image/query/anchor to a REAL endpoint, and stores the verbatim
 * vectors + an expected query×document score matrix in embeddings.json. The
 * e2e replay server (mock-embedding-server.mjs) then serves those vectors to
 * the app, so e2e journeys run against genuine model geometry — including
 * zh↔en cross-language retrieval — with no network and no GPU.
 *
 * To re-record against a new model/endpoint:
 *   EMBEDDING_ENDPOINT=https://… EMBEDDING_API_KEY=sk-… npm run record:embeddings
 * (add --render to re-rasterize the receipt images too).
 */

const receiptHtml = (opts: {
  title: string;
  subtitle?: string;
  lines: [string, string][];
  total: string;
  footer?: string;
}) => `<!doctype html><html><head><meta charset="utf-8"><style>
  @font-face { font-family: "CJK"; src: url("file://${process.cwd()}/assets/fonts/NotoSansCJKtc-Regular.otf"); }
  body { margin: 0; width: 640px; background: #f3f0e9; font-family: "Courier New", "CJK", monospace; }
  .paper { margin: 24px; background: #fffdf8; padding: 36px 32px; box-shadow: 0 1px 4px rgba(0,0,0,.25); }
  h1 { font-size: 30px; text-align: center; margin: 0 0 4px; letter-spacing: 1px; }
  .sub { text-align: center; font-size: 16px; color: #333; margin-bottom: 14px; }
  hr { border: none; border-top: 2px dashed #999; margin: 12px 0; }
  table { width: 100%; font-size: 19px; border-collapse: collapse; }
  td { padding: 5px 0; } td:last-child { text-align: right; }
  .total td { font-weight: bold; font-size: 22px; border-top: 2px solid #333; padding-top: 10px; }
  .foot { text-align: center; font-size: 14px; color: #555; margin-top: 16px; }
</style></head><body><div class="paper">
  <h1>${opts.title}</h1>
  ${opts.subtitle ? `<div class="sub">${opts.subtitle}</div>` : ""}
  <hr><table>
  ${opts.lines.map(([l, r]) => `<tr><td>${l}</td><td>${r}</td></tr>`).join("")}
  <tr class="total"><td>TOTAL</td><td>${opts.total}</td></tr>
  </table><hr>
  ${opts.footer ? `<div class="foot">${opts.footer}</div>` : ""}
</div></body></html>`;

export const RECEIPTS = [
  {
    id: "costco-tables",
    note: "folding tables and paper towels for the youth retreat",
    html: receiptHtml({
      title: "COSTCO WHOLESALE",
      subtitle: "Hayward #482 · 2026-06-21",
      lines: [
        ["KS PAPER TOWELS 12PK", "$18.99"],
        ["SNACK VARIETY PACK", "$21.13"],
        ["6FT FOLDING TABLE", "$61.98"],
      ],
      total: "$102.10",
      footer: "MEMBER 111792 · VISA ****4821",
    }),
  },
  {
    id: "starbucks-coffee",
    note: "coffee meeting with Pastor Lin",
    html: receiptHtml({
      title: "STARBUCKS",
      subtitle: "Store #1234 · 2026-06-14 08:32",
      lines: [
        ["GRANDE LATTE", "$4.50"],
        ["CAFFE AMERICANO", "$3.75"],
        ["BLUEBERRY MUFFIN", "$3.25"],
      ],
      total: "$11.50",
      footer: "Thank you!",
    }),
  },
  {
    id: "zh-grocery",
    note: "退修会零食",
    html: receiptHtml({
      title: "永和超级市场",
      subtitle: "收银台 03 · 2026-06-20 15:41",
      lines: [
        ["旺旺雪饼 大包", "$8.99"],
        ["瓜子 五香味 2袋", "$6.50"],
        ["水果糖 什锦", "$5.25"],
        ["纸杯 200只", "$7.99"],
      ],
      total: "$28.73",
      footer: "谢谢惠顾 欢迎再来",
    }),
  },
  {
    id: "zh-restaurant",
    note: "教会聚餐",
    html: receiptHtml({
      title: "长城饭店",
      subtitle: "桌号 12 · 2026-06-08 13:05",
      lines: [
        ["宫保鸡丁", "$16.95"],
        ["麻婆豆腐", "$12.95"],
        ["扬州炒饭 大", "$14.50"],
        ["酸辣汤 例", "$9.95"],
      ],
      total: "$54.35",
      footer: "多谢光临",
    }),
  },
] as const;

/** Queries are recorded WITH the instruction prefix, exactly as the app sends
 *  them. The four core journeys: en→en, zh→en, en→zh, zh→zh. */
export const QUERIES = [
  { id: "q-en-coffee", text: "coffee at Starbucks" },
  { id: "q-zh-coffee", text: "星巴克的咖啡" },
  { id: "q-en-snacks", text: "snacks for the retreat" },
  { id: "q-zh-snacks", text: "退修会的零食" },
  { id: "q-en-tables", text: "folding tables for the youth retreat" },
  { id: "q-zh-banquet", text: "教会聚餐的报销" },
] as const;

/** Doc-side anchor texts: strings the e2e journeys actually produce (claim
 *  descriptions/composites project onto these in the replay server, so
 *  dynamic composites still land in real model geometry). Embedded WITHOUT
 *  the query prefix, like every document. */
export const ANCHORS = [
  { id: "a-claim-banquet", text: "Reimbursement claim. 教会聚餐 church fellowship lunch. 长城饭店 restaurant." },
  { id: "a-claim-retreat", text: "Reimbursement claim. youth retreat supplies 退修会零食 snacks. 永和超级市场." },
  { id: "a-note-coffee", text: "A photographed purchase receipt. User note: coffee meeting with Pastor Lin." },
] as const;

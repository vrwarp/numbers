# Translation glossary

The load-bearing terms, decided once and used consistently across every
message. `scripts/translate-messages.ts` pins this table into each translation
prompt; reviewers enforce it. Change a term here → re-draft affected keys
(`npm run translate -- --all`) and have the reviewer re-bless them.

Note the pairs that differ by **vocabulary**, not just script — this is why
zh-Hant is a hand-maintained catalog, never a character-level conversion of
zh-Hans (登录→登錄 would be wrong; Taiwan says 登入).

| en | zh-Hans | zh-Hant | note |
| :-- | :-- | :-- | :-- |
| receipt | 收据 | 收據 | measure word: 张 / 張 |
| CFCC / Chinese For Christ Church of Hayward | 中华归主海沃教会 | 中華歸主海沃教會 | the English abbreviation never appears in Chinese text; “the CFCC form” → 教会报销表 / 教會報銷表 |
| claim / reimbursement | 报销单 / 报销 | 報銷單 / 報銷 | |
| Receipts (the capture page) | 收据 | 收據 | tab/page name; the code still calls it “Shoebox” internally |
| ministry | 事工 | 事工 | standard church usage |
| event | 活动 | 活動 | |
| verify / verified | 核对 / 已核对 | 核對 / 已核對 | |
| draft | 草稿 | 草稿 | |
| generated | 已生成 | 已產生 | vocabulary divergence |
| split / merge | 拆分 / 合并 | 拆分 / 合併 | |
| exclude / restore | 排除 / 恢复 | 排除 / 恢復 | |
| upload | 上传 | 上傳 | |
| sign in / sign out | 登录 / 退出登录 | 登入 / 登出 | vocabulary divergence |
| save | 保存 | 儲存 | vocabulary divergence |
| apply | 应用 | 套用 | vocabulary divergence |
| loading | 加载中 | 載入中 | vocabulary divergence |
| undo | 撤销 | 復原 | vocabulary divergence |
| suggest (AI) | 建议 | 建議 | |
| total / subtotal | 总额 / 小计 | 總額 / 小計 | |
| refund | 退款 | 退款 | |
| row (line item) | 行 | 列 | TW convention for table rows |
| optional | 可选 / （可选） | 選填 / （選填） | |
| description / note | 说明 | 說明 | receipt note; row description = 描述 |
| profile | 个人资料 | 個人資料 | |
| photo | 照片 | 相片 | |
| crop | 裁剪 | 裁切 | |
| retreat | 退修会 | 退修會 | church register |

Never translated: **Numbers** (app name), ministry canonical values
(`237 Office Supplies` — they are stored data, printed on the official form,
and the AI-suggestion validation key), account numbers, merchant names, file
names, anything the user typed. Quotation marks follow each script's
convention: “…” in zh-Hans, 「…」 in zh-Hant.

Review status lives in `messages/translation-state.json` (`todo` → `machine` →
`reviewed`); flip a key to `reviewed` in the same PR that blesses its wording.
Both Chinese catalogs are currently `machine` drafts — authored with glossary
discipline, but pending a native reviewer from the congregation per script.

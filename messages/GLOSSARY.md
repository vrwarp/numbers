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
| search | 搜索 | 搜尋 | vocabulary divergence |
| whole church (search scope) | 全教会 | 全教會 | the congregation's data, not the building |
| decide (a claim) | 审批 | 審批 | completed aspect for past decisions: 我审批过的 / 我審批過的 — never 决定 (wrong register); bare 我审批的 reads as "awaiting my approval" |
| not on a claim | 未加入报销单 | 未加入報銷單 | receipt-state chip |
| exact match (search) | 完全匹配 | 完全符合 | vocabulary divergence |
| electronic signing / e-sign | 电子签名 | 電子簽名 | the feature as a whole |
| sign (a ceremony) | 签署 | 簽署 | the act of signing a claim/vouch; drawing the signature = 签名 / 簽名 |
| signature (drawn) | 签名 | 簽名 | the hand-drawn mark |
| submit (for approval) | 提交 | 提交 | claim → approver |
| approve / approver | 批准 / 审批人 | 批准 / 審批人 | |
| reject | 拒绝 | 拒絕 | approver's decision |
| awaiting approval | 待审批 | 待審批 | the `submitted` status chip |
| paid | 已支付 | 已支付 | terminal claim status |
| treasurer | 财务同工 | 財務同工 | church register, not corporate 财务主管 |
| chairman (board) | 主席 | 主席 | executive officer of the board |
| secretary (board) | 文书 | 文書 | executive officer; church register, not office 秘书 |
| executive officer | 执行同工 | 執行同工 | the board's chairman / secretary / treasurer |
| admin / administrator | 管理员 | 管理員 | |
| vouch (voucher-facing) | 担保 | 擔保 | the VOUCHER's act and ceremony surfaces only — the voucher is taking responsibility, so the guarantor register is correct there |
| vouch (candidate-facing) | 当面确认 | 當面確認 | what the CANDIDATE experiences: “two members confirm it's really you, in person”. Never 担保/擔保 on candidate-facing setup/nudge surfaces — to a member that word reads as co-signing a loan |
| attest / attested | 认证 / 已认证 | 認證 / 已認證 | roster status after enough vouches |
| enroll (in signing) | 开通 | 開通 | friendlier than 注册 for church members |
| certificate (approval) | 批准证书 | 批准證書 | the PDF cover artifact |
| packet | 报销文件 | 報銷文件 | the generated PDF (form + receipts) |
| verify / verification (signatures) | 验证 | 驗證 | distinct from receipt 核对 / 核對 |
| key fingerprint | 密钥指纹 | 金鑰指紋 | vocabulary divergence (密钥 vs 金鑰) |
| device | 设备 | 裝置 | vocabulary divergence |
| recovery phrase / sheet | 恢复短语 / 恢复单 | 復原口令 / 復原單 | 24 English BIP39 words — the words themselves stay English |
| withdraw (a submission) | 撤回 | 撤回 | |
| check (payment) | 支票 | 支票 | check number = 支票号码 / 支票號碼 |

Register: new member-facing nudge/duty surfaces (the e-sign setup
discoverability set) address the reader as 您 — they speak to elders and
officers directly. Follow suit when extending them.

Never translated: **Numbers** (app name), ministry canonical values
(`237 Office Supplies` — they are stored data, printed on the official form,
and the AI-suggestion validation key), account numbers, merchant names, file
names, anything the user typed, recovery-phrase words (always English BIP39),
and the UETA consent document in `src/lib/esign/consent.ts` — its SHA-256 is a
signed input (`consentSha256`), so the binding text stays the English ueta-v1
version verbatim; the UI translates only the chrome around it and says so
(`Esign.consentEnglishNote`). Quotation marks follow each script's
convention: “…” in zh-Hans, 「…」 in zh-Hant.

Review status lives in `messages/translation-state.json` (`todo` → `machine` →
`reviewed`); flip a key to `reviewed` in the same PR that blesses its wording.
Both Chinese catalogs are currently `machine` drafts — authored with glossary
discipline, but pending a native reviewer from the congregation per script.

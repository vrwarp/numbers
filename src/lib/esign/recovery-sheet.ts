"use client";

/**
 * Printable recovery sheet (docs/MULTI_DEVICE_PLAN.md M4, print-first per
 * owner direction): a letter-size PDF carrying the member's 24-word phrase.
 * Built ENTIRELY in the browser with pdf-lib — the phrase is the member's
 * signing identity, so it must never travel to the server (which stays
 * keyless by design). The caller hands the bytes to a download; nothing is
 * persisted anywhere.
 */

export interface RecoverySheetInput {
  words: string[];
  name: string;
  email: string;
}

export async function buildRecoverySheetPdf(input: RecoverySheetInput): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]); // US letter
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const mono = await doc.embedFont(StandardFonts.Courier);

  const ink = rgb(0.11, 0.09, 0.09);
  const soft = rgb(0.42, 0.4, 0.38);
  const margin = 54;
  let y = 792 - 64;

  page.drawText("Signing recovery sheet", { x: margin, y, size: 24, font: bold, color: ink });
  y -= 20;
  page.drawText("Numbers — CFCC reimbursements · electronic signing", {
    x: margin,
    y,
    size: 11,
    font: helv,
    color: soft,
  });
  y -= 26;
  page.drawLine({
    start: { x: margin, y },
    end: { x: 612 - margin, y },
    thickness: 1,
    color: rgb(0.85, 0.84, 0.82),
  });
  y -= 24;

  // Built client-side with the standard fonts only, so a name outside
  // WinAnsi (e.g. Chinese) can't be drawn — fall back to the email, which
  // identifies the member just as well on a sheet they keep at home.
  const canEncode = (s: string) => {
    try {
      helv.widthOfTextAtSize(s, 12);
      return true;
    } catch {
      return false;
    }
  };
  const forLine = canEncode(input.name) ? `For: ${input.name}  (${input.email})` : `For: ${input.email}`;
  page.drawText(forLine, { x: margin, y, size: 12, font: helv, color: ink });
  y -= 16;
  page.drawText(`Printed: ${new Date().toLocaleDateString()}`, { x: margin, y, size: 12, font: helv, color: ink });
  y -= 30;

  // The 24 words, two columns of twelve, big enough to read years later.
  const colX = [margin, 612 / 2 + 10];
  const rowH = 24;
  const wordsTop = y;
  for (let i = 0; i < input.words.length; i++) {
    const col = i < 12 ? 0 : 1;
    const row = i % 12;
    const yy = wordsTop - row * rowH;
    page.drawText(`${String(i + 1).padStart(2, " ")}.`, {
      x: colX[col],
      y: yy,
      size: 13,
      font: mono,
      color: soft,
    });
    page.drawText(input.words[i], { x: colX[col] + 34, y: yy, size: 15, font: bold, color: ink });
  }
  y = wordsTop - 12 * rowH - 16;

  const lines = [
    "What this is: the one backup of your electronic-signing identity. On a new",
    "device, choose “Type my 24-word recovery phrase” and copy the words from",
    "this sheet, in order.",
    "",
    "Keep it somewhere safe at home (with your other important papers).",
    "Anyone holding this sheet can sign reimbursements as you.",
    "Nobody can recreate it — not the church, not the app. If it's lost, you'll",
    "set up signing again and be vouched for again in person.",
  ];
  for (const line of lines) {
    page.drawText(line, { x: margin, y, size: 12, font: line.startsWith("Keep") || line.startsWith("Anyone") ? bold : helv, color: ink });
    y -= 17;
  }

  return doc.save();
}

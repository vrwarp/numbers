import { describe, expect, it } from "vitest";
import { contentDisposition } from "@/lib/http";

/**
 * The receipt-download route builds a Content-Disposition header from the raw
 * uploaded filename. The `Headers` constructor throws on bytes > 0xFF and on
 * CR/LF, so a Chinese filename used to 500 the download in an app localized
 * for zh users. These tests pin the RFC 5987 encoding and header-safety.
 */
describe("contentDisposition", () => {
  it("produces a header value the Headers constructor accepts for any filename", () => {
    for (const name of ["收据.jpg", "reçu.pdf", "😀.png", "a\r\nb.jpg", 'quote".jpg', "café 　 scan.heic"]) {
      const value = contentDisposition(name);
      // The real failure mode: does Headers accept it?
      expect(() => new Headers({ "Content-Disposition": value })).not.toThrow();
    }
  });

  it("emits an ASCII fallback plus a UTF-8 filename* for non-Latin names", () => {
    const value = contentDisposition("收据.jpg");
    expect(value).toMatch(/^inline; filename="[\x20-\x7e]*"; filename\*=UTF-8''/);
    // The extended field round-trips back to the original name.
    const star = value.split("filename*=UTF-8''")[1];
    expect(decodeURIComponent(star)).toBe("收据.jpg");
  });

  it("keeps a plain ASCII name legible in the fallback", () => {
    const value = contentDisposition("receipt-2026.pdf");
    expect(value).toContain('filename="receipt-2026.pdf"');
  });

  it("strips control characters and never lets a quote break the token", () => {
    const value = contentDisposition('a"b\r\nc.jpg');
    const fallback = value.match(/filename="([^"]*)"/)![1];
    expect(fallback).not.toContain('"');
    expect(value).not.toMatch(/[\r\n]/);
  });

  it("falls back to a non-empty name when the input is all control chars", () => {
    expect(contentDisposition("\r\n\t")).toContain('filename="download"');
  });

  it("honours the attachment disposition type", () => {
    expect(contentDisposition("x.csv", "attachment")).toMatch(/^attachment; /);
  });
});

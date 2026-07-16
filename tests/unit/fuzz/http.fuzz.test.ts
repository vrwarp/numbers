import { describe, expect } from "vitest";
import { contentDisposition } from "@/lib/http";
import { fuzz } from "./prng";

/**
 * The download route feeds arbitrary uploaded filenames into a header. The
 * one property that must never break: the emitted value is always accepted by
 * the Headers constructor (no > 0xFF byte, no CR/LF), whatever the filename.
 */
describe("contentDisposition fuzz", () => {
  fuzz("every filename yields a header the Headers constructor accepts", { iters: 500 }, (rng) => {
    const name = rng.unicodeString(rng.int(0, 40));
    const value = contentDisposition(name, rng.bool() ? "inline" : "attachment");
    expect(() => new Headers({ "Content-Disposition": value })).not.toThrow();
    // Structure holds: an ASCII fallback and a UTF-8 extended field.
    expect(value).toMatch(/^(inline|attachment); filename="[\x20-\x7e]*"; filename\*=UTF-8''/);
    // The ASCII fallback is pure printable ASCII with no bare quote.
    const fallback = value.match(/filename="([^"]*)"/)![1];
    expect(fallback).toMatch(/^[\x20-\x7e]*$/);
  });

  fuzz("the filename* field round-trips to the control-stripped, trimmed name", { iters: 300 }, (rng) => {
    const raw = rng.asciiString(30);
    const expected = raw.replace(/[\x00-\x1f\x7f]/g, "").trim();
    if (!expected) return; // empty → falls back to "download", covered elsewhere
    const value = contentDisposition(raw);
    const star = value.split("filename*=UTF-8''")[1];
    expect(decodeURIComponent(star)).toBe(expected);
  });
});

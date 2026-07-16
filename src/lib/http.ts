/**
 * HTTP header helpers. Dependency-free and pure so they can be unit-tested
 * without a request.
 */

/**
 * Build a `Content-Disposition: inline` header value that is safe for ANY
 * filename, including Chinese ones. The `Headers` constructor throws on
 * bytes > 0xFF and on CR/LF, so a raw `filename="收据.jpg"` (or a name with an
 * embedded newline) would 500 the download. We emit an ASCII-only `filename=`
 * fallback plus an RFC 5987 `filename*` with the real UTF-8 name percent-
 * encoded, exactly as browsers expect.
 */
export function contentDisposition(originalName: string, type: "inline" | "attachment" = "inline"): string {
  // Strip control chars (CR/LF/NUL etc.) that are illegal in header values.
  const clean = originalName.replace(/[\x00-\x1f\x7f]/g, "").trim() || "download";

  // ASCII fallback: replace every non-printable-ASCII (and the quote/backslash)
  // with "_" so legacy clients still get a usable name.
  const asciiFallback = clean.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");

  // RFC 5987: percent-encode the UTF-8 bytes; encodeURIComponent covers the
  // attr-char rules (it leaves A–Z a–z 0–9 - _ . ! ~ * ' ( ) which are all
  // legal in ext-value).
  const encoded = encodeURIComponent(clean);

  return `${type}; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}

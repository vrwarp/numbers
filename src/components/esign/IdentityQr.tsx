"use client";

import { useMemo } from "react";
import { useTranslations } from "next-intl";
import qrcode from "qrcode-generator";

/** SVG QR of a /vouch URL — scanned by the voucher, either in-page
 *  (VouchQrScanner) or with their phone's camera app opening the link. */
export default function IdentityQr({ url }: { url: string }) {
  const t = useTranslations("Identity");
  const svg = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(url);
    qr.make();
    const n = qr.getModuleCount();
    const cells: string[] = [];
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (qr.isDark(r, c)) cells.push(`M${c},${r}h1v1h-1z`);
      }
    }
    return { n, path: cells.join("") };
  }, [url]);

  return (
    <div className="flex flex-col items-center gap-2">
      <svg
        viewBox={`-2 -2 ${svg.n + 4} ${svg.n + 4}`}
        className="h-48 w-48 rounded-lg bg-white p-1 shadow-sm"
        role="img"
        aria-label={t("qrAria")}
        data-testid="identity-qr"
      >
        <rect x={-2} y={-2} width={svg.n + 4} height={svg.n + 4} fill="#fff" />
        <path d={svg.path} fill="#1c1917" />
      </svg>
      <a href={url} className="text-xs text-stone-400 underline" data-testid="vouch-url">
        {t("openLink")}
      </a>
    </div>
  );
}

import { prisma } from "@/lib/prisma";
import { queryTerms, escapeLike, parseQueryMoneyCents } from "./normalize";

/**
 * The exact-match pass (docs/SEARCH_DESIGN.md §6.2): tokenized AND over
 * merchant/note/originalName/description/claimDescription plus cents equality
 * for money-like terms. Raw LOWER(col) LIKE ? ESCAPE '\' because Prisma
 * `contains` on SQLite is ASCII-case-partial and doesn't escape wildcards.
 * A scoped table scan — fine at church scale. No provider dependency, so it
 * doubles as the degraded mode when the embed call fails.
 */

export type ExactScope =
  | { kind: "mine"; userId: string }
  | { kind: "all" }
  | { kind: "decided"; claimIds: string[]; receiptIds: string[] };

export type ExactMatches = { receiptIds: string[]; claimIds: string[] };

const CAP = 20; // API cap; UI shows 3 + "Show all N"

export async function exactMatchPass(
  rawQuery: string,
  scope: ExactScope,
  types: ("receipt" | "claim")[]
): Promise<ExactMatches> {
  const terms = queryTerms(rawQuery);
  if (!terms.length) return { receiptIds: [], claimIds: [] };

  const receiptIds: string[] = [];
  const claimIds: string[] = [];

  if (types.includes("receipt")) {
    const conds: string[] = [];
    const params: (string | number)[] = [];
    for (const term of terms) {
      const like = `%${escapeLike(term)}%`;
      const cents = parseQueryMoneyCents(term);
      const money =
        cents !== null ? ` OR r.extractedTotalCents = ? OR li.amountCents = ?` : "";
      conds.push(
        `(LOWER(r.merchant) LIKE ? ESCAPE '\\' OR LOWER(r.note) LIKE ? ESCAPE '\\' OR LOWER(r.originalName) LIKE ? ESCAPE '\\'${money})`
      );
      params.push(like, like, like);
      if (cents !== null) params.push(cents, cents);
    }
    let scopeSql = "";
    if (scope.kind === "mine") {
      scopeSql = " AND r.userId = ?";
      params.push(scope.userId);
    } else if (scope.kind === "decided") {
      if (!scope.receiptIds.length) return { receiptIds: [], claimIds: await exactClaims() };
      scopeSql = ` AND r.id IN (${scope.receiptIds.map(() => "?").join(",")})`;
      params.push(...scope.receiptIds);
    }
    const rows = await prisma.$queryRawUnsafe<{ id: string }[]>(
      `SELECT DISTINCT r.id, r.createdAt FROM Receipt r
       LEFT JOIN LineItem li ON li.receiptId = r.id
       WHERE ${conds.join(" AND ")}${scopeSql}
       ORDER BY r.createdAt DESC LIMIT ${CAP}`,
      ...params
    );
    receiptIds.push(...rows.map((r) => r.id));
  }

  async function exactClaims(): Promise<string[]> {
    if (!types.includes("claim")) return [];
    const conds: string[] = [];
    const params: (string | number)[] = [];
    for (const term of terms) {
      const like = `%${escapeLike(term)}%`;
      const cents = parseQueryMoneyCents(term);
      const money = cents !== null ? ` OR c.totalCents = ? OR li.amountCents = ?` : "";
      conds.push(
        `(LOWER(c.claimDescription) LIKE ? ESCAPE '\\' OR LOWER(li.description) LIKE ? ESCAPE '\\'${money})`
      );
      params.push(like, like);
      if (cents !== null) params.push(cents, cents);
    }
    let scopeSql = "";
    if (scope.kind === "mine") {
      scopeSql = " AND c.userId = ?";
      params.push(scope.userId);
    } else if (scope.kind === "decided") {
      if (!scope.claimIds.length) return [];
      scopeSql = ` AND c.id IN (${scope.claimIds.map(() => "?").join(",")})`;
      params.push(...scope.claimIds);
    }
    const rows = await prisma.$queryRawUnsafe<{ id: string }[]>(
      `SELECT DISTINCT c.id, c.createdAt FROM Reimbursement c
       LEFT JOIN LineItem li ON li.reimbursementId = c.id
       WHERE ${conds.join(" AND ")}${scopeSql}
       ORDER BY c.createdAt DESC LIMIT ${CAP}`,
      ...params
    );
    return rows.map((r) => r.id);
  }

  claimIds.push(...(await exactClaims()));
  return { receiptIds, claimIds };
}

import { describe, expect, it } from "vitest";
import {
  flatten,
  messageArguments,
  unflatten,
  type Messages,
} from "@/lib/translation-state";

describe("flatten", () => {
  it("dots nested keys into a flat map", () => {
    const m = flatten({ a: "1", b: { c: "2", d: { e: "3" } } });
    expect(m.get("a")).toBe("1");
    expect(m.get("b.c")).toBe("2");
    expect(m.get("b.d.e")).toBe("3");
    expect(m.size).toBe(3);
  });

  it("honours a prefix", () => {
    const m = flatten({ c: "2" }, "b");
    expect([...m]).toEqual([["b.c", "2"]]);
  });

  it("empty object → empty map", () => {
    expect(flatten({}).size).toBe(0);
  });

  it("keeps unicode values intact", () => {
    const m = flatten({ greet: "简体中文 🧾" });
    expect(m.get("greet")).toBe("简体中文 🧾");
  });
});

describe("unflatten", () => {
  it("rebuilds nesting following the given key order", () => {
    const flat = new Map([
      ["b.d.e", "3"],
      ["a", "1"],
      ["b.c", "2"],
    ]);
    const out = unflatten(flat, ["a", "b.c", "b.d.e"]) as Messages;
    expect(out).toEqual({ a: "1", b: { c: "2", d: { e: "3" } } });
  });

  it("skips keys absent from the flat map", () => {
    const flat = new Map([["a", "1"]]);
    expect(unflatten(flat, ["a", "missing.key"])).toEqual({ a: "1" });
  });

  it("round-trips through flatten", () => {
    const original: Messages = {
      Nav: { home: "Home", search: "Search" },
      Common: { yes: "Yes", nested: { deep: "Deep" } },
    };
    const flat = flatten(original);
    const rebuilt = unflatten(flat, [...flat.keys()]);
    expect(rebuilt).toEqual(original);
  });

  it("empty order → empty object", () => {
    expect(unflatten(new Map([["a", "1"]]), [])).toEqual({});
  });
});

describe("messageArguments", () => {
  const cases: [string, string[]][] = [
    ["No arguments here", []],
    ["You have {count} receipts", ["{count}"]],
    ["{count, plural, one {# item} other {# items}}", ["{count}"]], // plural head only
    ["{merchant} on {date}", ["{date}", "{merchant}"]], // sorted
    ["Open the <link>dashboard</link>", ["<link>"]],
    ["Hi {name}, see <link>here</link>", ["<link>", "{name}"]], // tags + args sorted together
    ["{a} and {a} again", ["{a}"]], // de-duplicated
    ["{ spaced }", ["{spaced}"]], // whitespace inside braces tolerated
    ["<b>bold</b> and <link>x</link>", ["<b>", "<link>"]],
    ["price is ${amount}", ["{amount}"]], // literal $ is not a tag
  ];
  it.each(cases)("messageArguments(%o)", (msg, want) => {
    expect(messageArguments(msg)).toEqual(want);
  });

  it("ignores rich tags that are not lowercase-initial", () => {
    // The tag regex requires a lowercase first letter, so <Link>/<1> are ignored.
    expect(messageArguments("<Link>x</Link> <1>y</1>")).toEqual([]);
  });
});

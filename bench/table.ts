// How the benchmarks print a table: aligned, with a bold header and dim rules on a terminal, or as
// Markdown with `--markdown` (what bench/README.md records). Colour only on a TTY, never under
// NO_COLOR.

export type Column = { readonly title: string; readonly align: "left" | "right" };

const markdown = process.argv.includes("--markdown");
const color = process.stdout.isTTY === true && !("NO_COLOR" in process.env) && !markdown;
const paint = (code: string) => (s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
export const bold = paint("1");
export const dim = paint("2");

/** The arguments that are not flags. */
export const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));

/** A number with `digits` decimals, never "-0.0". */
export const fixed = (n: number, digits = 1): string =>
  (Object.is(n, -0) || Math.abs(n) < 10 ** -digits / 2 ? 0 : n).toFixed(digits);

export function print(title: string, columns: readonly Column[], rows: readonly string[][]): void {
  const widths = columns.map((c, i) =>
    Math.max(c.title.length, ...rows.map((r) => (r[i] ?? "").length)),
  );
  const cell = (s: string, i: number) =>
    columns[i]?.align === "right" ? s.padStart(widths[i] ?? 0) : s.padEnd(widths[i] ?? 0);
  if (markdown) {
    console.log(`${title}\n`);
    console.log(`| ${columns.map((c, i) => cell(c.title, i)).join(" | ")} |`);
    console.log(
      `| ${columns.map((c, i) => (c.align === "right" ? `${"-".repeat((widths[i] ?? 1) - 1)}:` : "-".repeat(widths[i] ?? 0))).join(" | ")} |`,
    );
    for (const r of rows) console.log(`| ${r.map(cell).join(" | ")} |`);
    return;
  }
  const rule = dim(widths.map((w) => "─".repeat(w)).join("──"));
  console.log(`\n${bold(title)}\n`);
  console.log(columns.map((c, i) => bold(cell(c.title, i))).join("  "));
  console.log(rule);
  for (const r of rows) console.log(r.map(cell).join("  "));
  console.log(rule);
}

/** A line that rewrites itself on a terminal, to show what is being measured. */
export function status(text: string): void {
  if (process.stderr.isTTY) process.stderr.write(`\r\x1b[2K${dim(text)}`);
}
export const clearStatus = (): void => {
  if (process.stderr.isTTY) process.stderr.write("\r\x1b[2K");
};

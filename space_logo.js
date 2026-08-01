#!/usr/bin/env node
// space_logo.js
// Rewrites a *Logo.tsx file's template-literal ASCII art by regenerating it
// with figlet using the ANSI Shadow font. The label is read from the
// aria-label attr. By default letters are rendered with figlet's default
// spacing (no extra gap between letters); pass --gap=N to insert N spaces
// between letters.
//
// Usage:
//   node space_logo.js <Logo.tsx> [--gap=N]
//
// Requires: npx figlet-cli (will be invoked via npx).
//
// Useful for generating/refreshing the home-screen ASCII logo of any app in
// this suite so it matches the shared visual identity (see AGENTS.md).

const fs = require("fs");
const { execSync } = require("child_process");

function figlet(word, font = "ANSI Shadow", gap = 0) {
  // By default, render the word with figlet's native spacing (no extra gap
  // between letters). When gap > 0, insert that many spaces between each
  // character and collapse figlet's wide space glyph down to that width.
  const spaced = gap > 0 ? word.split("").join(" ".repeat(gap)) : word;
  const cmd = `npx --yes figlet-cli -f "${font}" "${spaced}"`;
  const out = execSync(cmd, { encoding: "utf8" });
  const raw = out
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""));
  while (raw.length && raw[0] === "") raw.shift();
  while (raw.length && raw[raw.length - 1] === "") raw.pop();
  return gap > 0 ? collapseLetterGaps(raw.join("\n"), gap) : raw.join("\n");
}

function collapseLetterGaps(text, targetGap = 1) {
  const lines = text.split("\n");
  if (lines.length === 0) return "";
  const width = Math.max(...lines.map((l) => l.length));
  const padded = lines.map((l) => l.padEnd(width, " "));

  // A column is a separator if every char in it is whitespace.
  const isSep = [];
  for (let x = 0; x < width; x++) {
    let sep = true;
    for (let y = 0; y < padded.length; y++) {
      if (padded[y][x] !== " ") { sep = false; break; }
    }
    isSep.push(sep);
  }

  const out = padded.map(() => "");
  let x = 0;
  while (x < width) {
    if (isSep[x]) {
      const start = x;
      while (x < width && isSep[x]) x++;
      const end = x;
      const len = end - start;
      const hasLeft  = start > 0     && !isSep[start - 1];
      const hasRight = end   < width && !isSep[end];
      // Inter-letter gap -> collapse to targetGap. Leading/trailing/internal
      // whitespace runs are preserved as-is.
      const newRun = (hasLeft && hasRight && len > targetGap)
        ? " ".repeat(targetGap)
        : " ".repeat(len);
      for (let y = 0; y < padded.length; y++) out[y] += newRun;
    } else {
      for (let y = 0; y < padded.length; y++) out[y] += padded[y][x];
      x++;
    }
  }
  return out.map((l) => l.replace(/\s+$/, "")).join("\n");
}

function main() {
  const args = process.argv.slice(2);
  const gapArg = args.find((a) => a.startsWith("--gap="));
  const gap = gapArg ? parseInt(gapArg.slice(6), 10) : 0;
  const file = args.find((a) => !a.startsWith("--"));
  if (!file) {
    console.error("Usage: node space_logo.js <Logo.tsx> [--gap=N]");
    process.exit(1);
  }

  const src = fs.readFileSync(file, "utf8");

  // Read the word from aria-label="...".
  const labelMatch = src.match(/aria-label="([^"]+)"/);
  if (!labelMatch) {
    console.error(`No aria-label found in ${file}`);
    process.exit(2);
  }
  const word = labelMatch[1];

  const art = figlet(word, "ANSI Shadow", gap);

  // Replace the template literal contents.
  const m = src.match(/\{`([\s\S]*?)`\}/);
  if (!m) {
    console.error(`No template literal found in ${file}`);
    process.exit(3);
  }

  const before = src.slice(0, m.index);
  const after  = src.slice(m.index + m[0].length);
  const newSrc = `${before}{\`${art}\`}${after}`;

  fs.writeFileSync(file, newSrc, "utf8");
  console.log(`Updated ${file} (figlet "ANSI Shadow", word="${word}", gap=${gap})`);
}

main();

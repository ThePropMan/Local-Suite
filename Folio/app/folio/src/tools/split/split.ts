import { PDFDocument } from "pdf-lib";

export function parseRanges(input: string, maxPage: number): { ok: boolean; error?: string; ranges: [number, number][] } {
  const ranges: [number, number][] = [];
  if (!input.trim()) return { ok: true, ranges };

  const parts = input.split(",").map((p) => p.trim()).filter(Boolean);
  for (const part of parts) {
    if (part.includes("-") || part.includes("–")) {
      const [a, b] = part.split(/[-–]/);
      const start = parseInt(a, 10);
      const end = parseInt(b, 10);
      if (Number.isNaN(start) || Number.isNaN(end) || start < 1 || end < start || end > maxPage) {
        return { ok: false, error: `Invalid range "${part}"`, ranges: [] };
      }
      ranges.push([start - 1, end - 1]);
    } else {
      const n = parseInt(part, 10);
      if (Number.isNaN(n) || n < 1 || n > maxPage) {
        return { ok: false, error: `Invalid page "${part}"`, ranges: [] };
      }
      ranges.push([n - 1, n - 1]);
    }
  }
  return { ok: true, ranges };
}

export async function splitPdf(bytes: Uint8Array, ranges: [number, number][]): Promise<{ name: string; bytes: Uint8Array }[]> {
  const source = await PDFDocument.load(bytes);
  const results: { name: string; bytes: Uint8Array }[] = [];
  for (const [start, end] of ranges) {
    const doc = await PDFDocument.create();
    const pageIndices = [];
    for (let i = start; i <= end; i++) pageIndices.push(i);
    const pages = await doc.copyPages(source, pageIndices);
    pages.forEach((p) => doc.addPage(p));
    const out = await doc.save();
    const label = start === end ? `p${start + 1}` : `p${start + 1}-${end + 1}`;
    results.push({ name: `${label}.pdf`, bytes: out });
  }
  return results;
}

import { PDFDocument } from "pdf-lib";

/**
 * Rebuild the PDF so pages appear in `newOrder`. `newOrder` is a list of
 * 0-based source page indices in the desired sequence. All indices must be
 * present exactly once (a permutation of 0..pageCount-1).
 */
export async function reorderPages(bytes: Uint8Array, newOrder: number[]): Promise<Uint8Array> {
  const source = await PDFDocument.load(bytes);
  const pageCount = source.getPageCount();
  if (newOrder.length !== pageCount) {
    throw new Error("Reorder list must include every page exactly once.");
  }
  const seen = new Set<number>();
  for (const i of newOrder) {
    if (i < 0 || i >= pageCount || seen.has(i)) {
      throw new Error("Reorder list must include every page exactly once.");
    }
    seen.add(i);
  }
  const dest = await PDFDocument.create();
  const copied = await dest.copyPages(source, newOrder);
  copied.forEach((p) => dest.addPage(p));
  return dest.save();
}

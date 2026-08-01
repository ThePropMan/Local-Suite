import { PDFDocument } from "pdf-lib";

/**
 * Remove the given page indices (0-based) from the PDF and return the new bytes.
 * Indices are deduped and sorted descending so removals don't shift later indices.
 */
export async function deletePages(bytes: Uint8Array, indices: number[]): Promise<Uint8Array> {
  const unique = Array.from(new Set(indices)).sort((a, b) => b - a);
  const pdfDoc = await PDFDocument.load(bytes);
  const pageCount = pdfDoc.getPageCount();
  for (const i of unique) {
    if (i < 0 || i >= pageCount) continue;
    pdfDoc.removePage(i);
  }
  return pdfDoc.save();
}

import type { PDFDocumentProxy, PDFPageProxy } from "../../lib/pdfjs";

export interface ScanResult {
  totalPages: number;
  /** 0-based page indices that have no extractable text (likely scanned images). */
  noTextPages: number[];
  /** 0-based page indices that have at least one text item. */
  textPages: number[];
}

/**
 * Diagnostic: walk every page and check whether pdf.js can extract any text
 * items. Pages with zero text items are almost certainly scanned images with
 * no OCR layer. This does NOT perform OCR — it just tells the user which
 * pages would benefit from it.
 */
export async function scanForTextLayer(doc: PDFDocumentProxy): Promise<ScanResult> {
  const noTextPages: number[] = [];
  const textPages: number[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    try {
      const content = await page.getTextContent();
      const hasText = content.items.some((it: any) => typeof it.str === "string" && it.str.trim().length > 0);
      if (hasText) textPages.push(i - 1);
      else noTextPages.push(i - 1);
    } catch {
      noTextPages.push(i - 1);
    }
  }
  return { totalPages: doc.numPages, noTextPages, textPages };
}

/** Count text items on a single page (used for the per-page breakdown). */
export async function countTextItems(page: PDFPageProxy): Promise<number> {
  try {
    const content = await page.getTextContent();
    return content.items.filter((it: any) => typeof it.str === "string" && it.str.trim().length > 0).length;
  } catch {
    return 0;
  }
}

import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

export type NumberPosition = "bottom-center" | "bottom-right" | "bottom-left" | "top-center" | "top-right" | "top-left";

export interface NumberOptions {
  startAt: number;
  position: NumberPosition;
  format: "n" | "n-of-m" | "page-n" | "page-n-of-m";
  fontSize: number;
  margin: number;
}

/**
 * Draw page numbers on every page of the PDF. Numbers are flattened into the
 * page content (not annotations), so they can't be easily removed later.
 */
export async function addPageNumbers(bytes: Uint8Array, opts: NumberOptions): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.load(bytes);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const pages = pdfDoc.getPages();
  const total = pages.length;
  const color = rgb(0.2, 0.2, 0.2);

  pages.forEach((page, i) => {
    const n = opts.startAt + i;
    const label = formatLabel(n, total, opts.format);
    const { width, height } = page.getSize();
    const textWidth = font.widthOfTextAtSize(label, opts.fontSize);
    const { x, y } = resolvePosition(opts.position, width, height, textWidth, opts.fontSize, opts.margin);
    page.drawText(label, { x, y, size: opts.fontSize, font, color });
  });

  return pdfDoc.save();
}

function formatLabel(n: number, total: number, format: NumberOptions["format"]): string {
  switch (format) {
    case "n-of-m": return `${n} / ${total}`;
    case "page-n": return `Page ${n}`;
    case "page-n-of-m": return `Page ${n} of ${total}`;
    case "n":
    default: return String(n);
  }
}

function resolvePosition(
  pos: NumberPosition,
  pageWidth: number,
  pageHeight: number,
  textWidth: number,
  fontSize: number,
  margin: number,
): { x: number; y: number } {
  const baseline = fontSize * 0.25;
  const isTop = pos.startsWith("top");
  const y = isTop ? pageHeight - margin - fontSize + baseline : margin + baseline;
  if (pos.endsWith("center")) return { x: (pageWidth - textWidth) / 2, y };
  if (pos.endsWith("right")) return { x: pageWidth - margin - textWidth, y };
  return { x: margin, y };
}

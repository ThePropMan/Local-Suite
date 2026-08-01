import { PDFDocument } from "pdf-lib";

export interface MergeFile {
  path: string;
  name: string;
  bytes: Uint8Array;
}

export async function mergePdfs(files: MergeFile[]): Promise<Uint8Array> {
  const merged = await PDFDocument.create();
  for (const file of files) {
    try {
      const pdf = await PDFDocument.load(file.bytes);
      const pages = await merged.copyPages(pdf, pdf.getPageIndices());
      pages.forEach((p) => merged.addPage(p));
    } catch (e: any) {
      if (e.name === "EncryptedPDFError" || e.message?.includes("encrypted")) {
        throw new Error(`Couldn't read ${file.name} — it may be password-protected.`);
      }
      throw new Error(`Couldn't read ${file.name}. Make sure it's a valid PDF.`);
    }
  }
  return merged.save();
}

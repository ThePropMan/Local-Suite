import { PDFCheckBox, PDFDocument, PDFTextField } from "pdf-lib";

export type FillFieldKind = "text" | "checkbox" | "unsupported";

export interface FillFieldWidget {
  fieldName: string;
  kind: FillFieldKind;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Locate every fillable widget in the document and figure out which page it
 * lives on and where (in PDF page-space units), so the UI can draw an
 * interactive overlay directly on top of the rendered page.
 */
export function getFillFieldWidgets(pdfDoc: PDFDocument): FillFieldWidget[] {
  const pages = pdfDoc.getPages();
  const pageIndexByRef = new Map<string, number>();
  pages.forEach((page, i) => pageIndexByRef.set(page.ref.toString(), i));

  const widgets: FillFieldWidget[] = [];
  const fields = pdfDoc.getForm().getFields();

  for (const field of fields) {
    const kind: FillFieldKind = field instanceof PDFTextField
      ? "text"
      : field instanceof PDFCheckBox
      ? "checkbox"
      : "unsupported";

    for (const widget of field.acroField.getWidgets()) {
      const pageRef = widget.P();
      const pageIndex = pageRef ? pageIndexByRef.get(pageRef.toString()) : undefined;
      if (pageIndex === undefined) continue;
      const { x, y, width, height } = widget.getRectangle();
      widgets.push({ fieldName: field.getName(), kind, page: pageIndex, x, y, width, height });
    }
  }

  return widgets;
}

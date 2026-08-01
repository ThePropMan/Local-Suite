import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentProxy, PDFPageProxy, PageViewport } from "pdfjs-dist";

export type { PDFDocumentProxy, PDFPageProxy, PageViewport };

let workerReady = false;
async function ensureMainThreadWorker() {
  if (workerReady) return;
  console.log("[pdfjs] importing worker module...");
  // @ts-ignore
  const mod = await import("pdfjs-dist/build/pdf.worker.mjs");
  console.log("[pdfjs] worker module:", mod, "WorkerMessageHandler:", mod?.WorkerMessageHandler);
  (globalThis as any).pdfjsWorker = mod;
  workerReady = true;
  console.log("[pdfjs] globalThis.pdfjsWorker set:", !!(globalThis as any).pdfjsWorker?.WorkerMessageHandler);
}

export async function loadDocument(bytes: Uint8Array): Promise<PDFDocumentProxy> {
  await ensureMainThreadWorker();
  const data = new Uint8Array(bytes).buffer;
  const loadingTask = pdfjs.getDocument({
    data,
    disableAutoFetch: true,
    disableStream: true,
  });
  return loadingTask.promise;
}

export function pdfToCssTransform(
  viewport: PageViewport,
  scale: number,
): { scale: number; offsetX: number; offsetY: number } {
  const cssScale = scale;
  const offsetX = -viewport.viewBox[0] * cssScale;
  const offsetY = viewport.height - viewport.viewBox[3] * cssScale;
  return { scale: cssScale, offsetX, offsetY };
}

export function cssPointToPdfPoint(
  x: number,
  y: number,
  viewport: PageViewport,
  scale: number,
): { x: number; y: number } {
  // `viewport` is the unscaled (scale: 1) viewport, so `viewport.height` is
  // already in PDF units — the on-screen page height in CSS px is
  // `viewport.height * scale`. Mixing the two without accounting for that
  // was the bug (dividing an already-PDF-unit quantity by `scale` again).
  const pdfX = x / scale;
  const pdfY = viewport.height - y / scale;
  return { x: pdfX, y: pdfY };
}

export function cssRectToPdfRect(
  x: number,
  y: number,
  width: number,
  height: number,
  viewport: PageViewport,
  scale: number,
): { x: number; y: number; width: number; height: number } {
  const tl = cssPointToPdfPoint(x, y + height, viewport, scale);
  return {
    x: tl.x,
    y: tl.y,
    width: Math.abs(width / scale),
    height: Math.abs(height / scale),
  };
}

export function pdfRectToCssRect(
  x: number,
  y: number,
  width: number,
  height: number,
  viewport: PageViewport,
  scale: number,
): { x: number; y: number; width: number; height: number } {
  const cssX = x * scale;
  const cssY = (viewport.height - (y + height)) * scale;
  return { x: cssX, y: cssY, width: width * scale, height: height * scale };
}

export function getViewportForScale(viewport: PageViewport, scale: number): PageViewport {
  return viewport.clone({ scale });
}

import { useEffect, useState, useCallback, useRef } from "react";
import { getStoreValue, setStoreValue, pickPdfFiles, pickDirectoryPath, readFileBytes, writeFileBytes, savePdfPath, type RecentFile, type Theme } from "./lib/tauri";
import { PDFDocument } from "pdf-lib";
import * as pdfjs from "pdfjs-dist";
// pdf_viewer.mjs expects globalThis.pdfjsLib to be set before import
(globalThis as any).pdfjsLib = pdfjs;
import { TextLayerBuilder } from "pdfjs-dist/web/pdf_viewer.mjs";
import { loadDocument, getViewportForScale, type PDFDocumentProxy, type PDFPageProxy } from "./lib/pdfjs";
import { getFillFieldWidgets, type FillFieldWidget } from "./lib/formFields";
import { TitleBar } from "./shared/components/TitleBar";
import { TopBar } from "./components/TopBar";
import { Toolbar, type Tool } from "./components/Toolbar";
import { ToolPanel } from "./shared/components/ToolPanel";
import { DropOverlay } from "./components/DropOverlay";
import { ToastContainer, showToast } from "./shared/components/Toast";
import { ErrorBoundary } from "./shared/components/ErrorBoundary";
import { RedactOverlay, type DraftRedactRegion } from "./components/RedactOverlay";
import { FillOverlay } from "./components/FillOverlay";
import { SignatureOverlay, type SignaturePlacement } from "./components/SignatureOverlay";
import { useRecentFiles } from "./shared/hooks/useRecentFiles";
import { MergePanel } from "./panels/MergePanel";
import { SplitPanel } from "./panels/SplitPanel";
import { CompressPanel } from "./panels/CompressPanel";
import { FillPanel } from "./panels/FillPanel";
import { SignPanel } from "./panels/SignPanel";
import { RedactPanel } from "./panels/RedactPanel";
import { DeletePanel } from "./panels/DeletePanel";
import { ReorderPanel } from "./panels/ReorderPanel";
import { NumberPanel } from "./panels/NumberPanel";
import { ScanPanel } from "./panels/ScanPanel";

type PageLayout = "continuous" | "single";

function applyTheme(theme: Theme) {
  const html = document.documentElement;
  if (theme === "system") {
    html.removeAttribute("data-theme");
  } else {
    html.setAttribute("data-theme", theme);
  }
}

export default function App() {
  const [filePath, setFilePath] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string>("");
  const [pageCount, setPageCount] = useState(0);
  const [pages, setPages] = useState<PDFPageProxy[]>([]);
  const [pdfDocProxy, setPdfDocProxy] = useState<PDFDocumentProxy | null>(null);
  const [zoom, setZoom] = useState(1.0);
  const [activeTool, setActiveTool] = useState<Tool | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [theme, setTheme] = useState<Theme>("system");
  const [outputFolder, setOutputFolder] = useState<string | null>(null);
  const [pageLayout, setPageLayout] = useState<PageLayout>("continuous");
  const [currentPage, setCurrentPage] = useState(0);
  const [redactRegions, setRedactRegions] = useState<DraftRedactRegion[]>([]);
  const [fillWidgets, setFillWidgets] = useState<FillFieldWidget[]>([]);
  const [fillValues, setFillValues] = useState<Record<string, string | boolean>>({});
  const [signature, setSignature] = useState<string | null>(null);
  const [signaturePlacement, setSignaturePlacement] = useState<SignaturePlacement | null>(null);
  const [dragging, setDragging] = useState(false);
  const { recent, addRecent, clearRecent } = useRecentFiles();

  const scrollRef = useRef<HTMLDivElement>(null);
  const loadFileRef = useRef<(path: string) => void>(() => {});

  const fillFields = Array.from(new Set(fillWidgets.map((w) => w.fieldName))).map((name) => {
    const value = fillValues[name];
    const filled = typeof value === "string" ? value.trim().length > 0 : !!value;
    return { name, filled };
  });

  useEffect(() => {
    getStoreValue<Theme>("theme").then((t) => { if (t) { setTheme(t); applyTheme(t); } });
    getStoreValue<string>("outputFolder").then((v) => v && setOutputFolder(v));
    getStoreValue<PageLayout>("pageLayout").then((v) => v && setPageLayout(v));
  }, []);

  const loadFile = useCallback(async (path: string) => {
    try {
      const bytes = await readFileBytes(path);
      const pdfDoc = await PDFDocument.load(bytes);
      const count = pdfDoc.getPageCount();
      const widgets = getFillFieldWidgets(pdfDoc);
      setFilePath(path);
      setFileName(path.split(/[\\/]/).pop() || path);
      setPageCount(count);
      setCurrentPage(0);
      setActiveTool(null);
      setRedactRegions([]);
      setFillWidgets(widgets);
      setFillValues({});
      setSignature(null);
      setSignaturePlacement(null);
      setPages([]);
      setPdfDocProxy(null);

      // Render real pages via pdf.js (runs on main thread — no Web Worker).
      try {
        const doc = await loadDocument(bytes);
        const loaded: PDFPageProxy[] = [];
        for (let i = 1; i <= doc.numPages; i++) loaded.push(await doc.getPage(i));
        setPages(loaded);
        setPdfDocProxy(doc);
      } catch (e) {
        console.error("[loadFile] pdf render failed:", e);
      }
    } catch (e: any) {
      console.error("[loadFile] error:", e);
      showToast("Couldn't read this file. Make sure it's a valid PDF.", "error");
    }
  }, []);
  loadFileRef.current = loadFile;

  const handleBrowse = useCallback(async () => {
    console.log("[handleBrowse] opening dialog");
    const paths = await pickPdfFiles(false);
    console.log("[handleBrowse] got paths:", paths);
    if (paths.length > 0) loadFile(paths[0]);
  }, [loadFile]);

  const handleFiles = useCallback((paths: string[]) => {
    console.log("[handleFiles] paths:", paths);
    if (paths.length > 0) loadFile(paths[0]);
  }, [loadFile]);

  // App-level drag/drop listener — works whether or not a file is already
  // open, so dropping a PDF onto the running window always loads it.
  // Uses a ref for loadFile so the effect only subscribes once (avoiding
  // duplicate listeners and HMR TDZ issues with the dependency array).
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    import("@tauri-apps/api/webview").then(async ({ getCurrentWebview }) => {
      const webview = getCurrentWebview();
      const fn = await webview.onDragDropEvent((event: { payload: { type: string; paths?: string[] } }) => {
        if (event.payload.type === "enter" || event.payload.type === "over") {
          setDragging(true);
        } else if (event.payload.type === "leave") {
          setDragging(false);
        } else if (event.payload.type === "drop") {
          setDragging(false);
          const paths = (event.payload.paths || []).filter((p: string) => p.toLowerCase().endsWith(".pdf"));
          if (paths.length > 0) loadFileRef.current(paths[0]);
        }
      });
      if (!cancelled) unlisten = fn;
    }).catch((e) => console.error("[App] drag listener failed:", e));
    return () => { cancelled = true; unlisten?.(); };
  }, []);

  const handleOpenRecent = useCallback((file: RecentFile) => {
    loadFile(file.path);
  }, [loadFile]);

  const handleToolClick = useCallback((tool: Tool) => {
    setActiveTool((prev) => (prev === tool ? null : tool));
  }, []);

  const handleClose = useCallback(() => {
    setFilePath(null);
    setFileName("");
    setPageCount(0);
    setPages([]);
    setPdfDocProxy(null);
    setCurrentPage(0);
    setActiveTool(null);
    setRedactRegions([]);
    setFillWidgets([]);
    setFillValues({});
    setSignature(null);
    setSignaturePlacement(null);
  }, []);

  const handleZoomIn = useCallback(() => setZoom((z) => Math.min(2.0, z + 0.1)), []);
  const handleZoomOut = useCallback(() => setZoom((z) => Math.max(0.5, z - 0.1)), []);

  // Zoom so the first page fits entirely within the scroll viewport.
  const handleZoomToFit = useCallback(() => {
    const el = scrollRef.current;
    if (!el || pages.length === 0) return;
    const vp = pages[0].getViewport({ scale: 1 });
    const availW = el.clientWidth - 64;   // stage__scroll horizontal padding (32px each side)
    const availH = el.clientHeight - 152; // top (64) + bottom (88) padding
    if (vp.width <= 0 || vp.height <= 0) return;
    const fit = Math.min(availW / (vp.width * BASE_SCALE), availH / (vp.height * BASE_SCALE));
    setZoom(Math.max(0.5, Math.min(2.0, fit)));
  }, [pages]);

  // Zoom so the first page's width matches the scroll viewport width.
  const handleZoomToWidth = useCallback(() => {
    const el = scrollRef.current;
    if (!el || pages.length === 0) return;
    const vp = pages[0].getViewport({ scale: 1 });
    const availW = el.clientWidth - 64;
    if (vp.width <= 0) return;
    const fit = availW / (vp.width * BASE_SCALE);
    setZoom(Math.max(0.5, Math.min(2.0, fit)));
  }, [pages]);

  const handlePageLayoutChange = useCallback((layout: PageLayout) => {
    setPageLayout(layout);
  }, []);

  const handleExport = useCallback(async () => {
    if (!filePath) return;
    try {
      const outputPath = await savePdfPath(filePath);
      if (!outputPath) return;
      const bytes = await readFileBytes(filePath);
      await writeFileBytes(outputPath, bytes);
      showToast("Exported a copy of this PDF", "success");
    } catch (e: any) {
      showToast(e.message || "Couldn't export this PDF", "error");
    }
  }, [filePath]);

  const handleThemeChange = useCallback(async (t: Theme) => {
    setTheme(t);
    applyTheme(t);
    await setStoreValue("theme", t);
  }, []);

  const handleChooseFolder = useCallback(async () => {
    const dir = await pickDirectoryPath();
    if (dir) {
      setOutputFolder(dir);
      await setStoreValue("outputFolder", dir);
    }
  }, []);

  const handleRecent = useCallback((file: RecentFile) => {
    addRecent(file);
  }, [addRecent]);

  const addRedactRegion = useCallback((region: DraftRedactRegion) => {
    setRedactRegions((prev) => [...prev, region]);
  }, []);
  const removeRedactRegion = useCallback((id: string) => {
    setRedactRegions((prev) => prev.filter((r) => r.id !== id));
  }, []);

  const onFillChange = useCallback((fieldName: string, value: string | boolean) => {
    setFillValues((prev) => ({ ...prev, [fieldName]: value }));
  }, []);

  const onSignatureChange = useCallback((dataUrl: string | null) => {
    setSignature(dataUrl);
    if (dataUrl && !signaturePlacement) {
      // Default to the bottom-right corner of the first page; the user can
      // drag it wherever it actually needs to go from there.
      setSignaturePlacement({ page: 0, x: 300, y: 40, width: 160, height: 60 });
    }
  }, [signaturePlacement]);

  const panelProps = { filePath, onRecent: handleRecent };

  return (
    <div className="app">
      <TitleBar appName="Folio" showSettings={showSettings} onToggleSettings={() => setShowSettings((s) => !s)} />
      <div className="stage">
        {!filePath ? (
          <DropOverlay
            onFiles={handleFiles}
            onBrowse={handleBrowse}
            recent={recent}
            onOpenRecent={handleOpenRecent}
            dragging={dragging}
          />
        ) : (
          <>
            <TopBar
              filename={fileName}
              pageCount={pageCount}
              zoom={zoom}
              onZoomIn={handleZoomIn}
              onZoomOut={handleZoomOut}
              onZoomToFit={handleZoomToFit}
              onZoomToWidth={handleZoomToWidth}
              onClose={handleClose}
            />
            <div className="stage__scroll" ref={scrollRef}>
              {pages.length > 0
                ? pageLayout === "single"
                  ? (() => {
                      const i = Math.min(currentPage, pages.length - 1);
                      const page = pages[i];
                      return (
                        <PdfPage
                          key={i}
                          page={page}
                          zoom={zoom}
                          pageIndex={i}
                          tool={activeTool}
                          redactRegions={redactRegions.filter((r) => r.page === i)}
                          onAddRedactRegion={addRedactRegion}
                          onRemoveRedactRegion={removeRedactRegion}
                          fillWidgets={fillWidgets.filter((w) => w.page === i)}
                          fillValues={fillValues}
                          onFillChange={onFillChange}
                          signature={signaturePlacement?.page === i ? signature : null}
                          signaturePlacement={signaturePlacement?.page === i ? signaturePlacement : null}
                          onMoveSignature={setSignaturePlacement}
                        />
                      );
                    })()
                  : pages.map((page, i) => (
                      <PdfPage
                        key={i}
                        page={page}
                        zoom={zoom}
                        pageIndex={i}
                        tool={activeTool}
                        redactRegions={redactRegions.filter((r) => r.page === i)}
                        onAddRedactRegion={addRedactRegion}
                        onRemoveRedactRegion={removeRedactRegion}
                        fillWidgets={fillWidgets.filter((w) => w.page === i)}
                        fillValues={fillValues}
                        onFillChange={onFillChange}
                        signature={signaturePlacement?.page === i ? signature : null}
                        signaturePlacement={signaturePlacement?.page === i ? signaturePlacement : null}
                        onMoveSignature={setSignaturePlacement}
                      />
                    ))
                : Array.from({ length: pageCount }).map((_, i) => <MockPage key={i} zoom={zoom} />)}
            </div>
            {pageLayout === "single" && pageCount > 1 && (
              <div className="page-nav">
                <button
                  className="page-nav__btn"
                  aria-label="Previous page"
                  disabled={currentPage === 0}
                  onClick={() => setCurrentPage((p) => Math.max(0, p - 1))}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M15 18l-6-6 6-6" /></svg>
                </button>
                <span className="page-nav__label">{currentPage + 1} / {pageCount}</span>
                <button
                  className="page-nav__btn"
                  aria-label="Next page"
                  disabled={currentPage >= pageCount - 1}
                  onClick={() => setCurrentPage((p) => Math.min(pageCount - 1, p + 1))}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M9 18l6-6-6-6" /></svg>
                </button>
              </div>
            )}
            <Toolbar activeTool={activeTool} onToolClick={handleToolClick} onExport={handleExport} />
            <ToolPanel title={activeTool || ""} open={activeTool !== null}>
              <ErrorBoundary key={activeTool || "none"}>
                {activeTool === "merge" && <MergePanel {...panelProps} />}
                {activeTool === "split" && <SplitPanel {...panelProps} pageCount={pageCount} />}
                {activeTool === "delete" && <DeletePanel {...panelProps} pageCount={pageCount} />}
                {activeTool === "reorder" && <ReorderPanel {...panelProps} pageCount={pageCount} />}
                {activeTool === "compress" && <CompressPanel {...panelProps} />}
                {activeTool === "number" && <NumberPanel {...panelProps} pageCount={pageCount} />}
                {activeTool === "fill" && <FillPanel {...panelProps} fields={fillFields} values={fillValues} />}
                {activeTool === "sign" && (
                  <SignPanel
                    {...panelProps}
                    signature={signature}
                    onSignatureChange={onSignatureChange}
                    placement={signaturePlacement}
                    pageCount={pageCount}
                    onPlacementChange={setSignaturePlacement}
                  />
                )}
                {activeTool === "redact" && <RedactPanel {...panelProps} regions={redactRegions} />}
                {activeTool === "scan" && <ScanPanel {...panelProps} pdfDoc={pdfDocProxy} />}
              </ErrorBoundary>
            </ToolPanel>
          </>
        )}
        {showSettings && (
          <div className="settings-overlay">
            <div className="tool-panel__header">Settings</div>
            <div>
              <label className="eyebrow" style={{ display: "block", marginBottom: 6 }}>Default output folder</label>
              <p style={{ fontSize: 11, color: "var(--text-3)", marginBottom: 8 }}>
                Where finished files are saved. Falls back to the source file's folder.
              </p>
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <button className="btn-ghost" onClick={handleChooseFolder}>Choose</button>
                {outputFolder && (
                  <span style={{ fontSize: 11, color: "var(--text-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 140 }}>{outputFolder}</span>
                )}
              </div>
            </div>
            <div>
              <label className="eyebrow" style={{ display: "block", marginBottom: 6 }}>Theme</label>
              <div className="preset-group">
                {(["system", "light", "dark"] as Theme[]).map((t) => (
                  <button
                    key={t}
                    className={`preset ${theme === t ? "preset--selected" : ""}`}
                    onClick={() => handleThemeChange(t)}
                  >
                    <div className="preset__label">{t === "system" ? "System" : t === "light" ? "Light" : "Dark"}</div>
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="eyebrow" style={{ display: "block", marginBottom: 6 }}>Page layout</label>
              <div className="preset-group">
                {(["continuous", "single"] as PageLayout[]).map((l) => (
                  <button
                    key={l}
                    className={`preset ${pageLayout === l ? "preset--selected" : ""}`}
                    onClick={() => handlePageLayoutChange(l)}
                  >
                    <div className="preset__label">{l === "continuous" ? "Continuous" : "Single"}</div>
                  </button>
                ))}
              </div>
            </div>
            {recent.length > 0 && (
              <div>
                <label className="eyebrow" style={{ display: "block", marginBottom: 6 }}>Recent files</label>
                <button className="btn-ghost" onClick={clearRecent}>Clear recent</button>
              </div>
            )}
          </div>
        )}
      </div>
      <ToastContainer />
    </div>
  );
}

const BASE_SCALE = 1.4;
const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;

interface PdfPageProps {
  page: PDFPageProxy;
  zoom: number;
  pageIndex: number;
  tool: Tool | null;
  redactRegions: DraftRedactRegion[];
  onAddRedactRegion: (region: DraftRedactRegion) => void;
  onRemoveRedactRegion: (id: string) => void;
  fillWidgets: FillFieldWidget[];
  fillValues: Record<string, string | boolean>;
  onFillChange: (fieldName: string, value: string | boolean) => void;
  signature: string | null;
  signaturePlacement: SignaturePlacement | null;
  onMoveSignature: (placement: SignaturePlacement) => void;
}

function PdfPage({
  page,
  zoom,
  pageIndex,
  tool,
  redactRegions,
  onAddRedactRegion,
  onRemoveRedactRegion,
  fillWidgets,
  fillValues,
  onFillChange,
  signature,
  signaturePlacement,
  onMoveSignature,
}: PdfPageProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerWrapperRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const renderTaskRef = useRef<ReturnType<PDFPageProxy["render"]> | null>(null);
  const textLayerBuilderRef = useRef<InstanceType<typeof TextLayerBuilder> | null>(null);
  const cssScale = BASE_SCALE * zoom;
  const rawViewport = page.getViewport({ scale: 1 });

  useEffect(() => {
    // Canvas viewport: render at dpr× for crisp high-DPI output
    const canvasVp = getViewportForScale(rawViewport, cssScale * dpr);
    // Text layer viewport: CSS-pixel scale only (TextLayer internally
    // multiplies by devicePixelRatio, so we must NOT include dpr here)
    const textVp = getViewportForScale(rawViewport, cssScale);

    setSize({ width: canvasVp.width / dpr, height: canvasVp.height / dpr });

    const canvas = canvasRef.current;
    if (canvas) {
      canvas.width = Math.floor(canvasVp.width);
      canvas.height = Math.floor(canvasVp.height);
      canvas.style.width = `${canvasVp.width / dpr}px`;
      canvas.style.height = `${canvasVp.height / dpr}px`;

      renderTaskRef.current?.cancel();
      const task = page.render({ canvas, viewport: canvasVp });
      renderTaskRef.current = task;
      task.promise.catch(() => {});
    }

    const wrapper = textLayerWrapperRef.current;
    if (wrapper) {
      // --total-scale-factor: CSS px per PDF unit (used by span font-size calcs)
      wrapper.style.setProperty("--total-scale-factor", String(cssScale));
      wrapper.style.setProperty("--scale-round-x", "1px");
      wrapper.style.setProperty("--scale-round-y", "1px");
      textLayerBuilderRef.current?.cancel();
      wrapper.replaceChildren();
      // TextLayerBuilder (from pdf.js's own web/pdf_viewer.mjs) wires up the
      // `.textLayer` div plus the `endOfContent`/`selecting` mouse-selection
      // helpers that the raw TextLayer class doesn't provide on its own -
      // without those, drag-selection doesn't extend properly into the gaps
      // between the absolutely-positioned text spans.
      const builder = new TextLayerBuilder({ pdfPage: page });
      textLayerBuilderRef.current = builder;
      wrapper.append(builder.div);
      builder.render({ viewport: textVp } as Parameters<typeof builder.render>[0]).catch(() => {});
    }

    return () => {
      renderTaskRef.current?.cancel();
      textLayerBuilderRef.current?.cancel();
    };
  }, [page, zoom]);

  return (
    <div className="pdf-page" style={{ width: size?.width || 0, height: size?.height || 0 }}>
      <canvas ref={canvasRef} />
      <div ref={textLayerWrapperRef} className="pdf-page__text-layer" />
      {tool === "redact" && (
        <RedactOverlay
          viewport={rawViewport}
          scale={cssScale}
          pageIndex={pageIndex}
          regions={redactRegions}
          onAdd={onAddRedactRegion}
          onRemove={onRemoveRedactRegion}
        />
      )}
      {tool === "fill" && fillWidgets.length > 0 && (
        <FillOverlay
          viewport={rawViewport}
          scale={cssScale}
          widgets={fillWidgets}
          values={fillValues}
          onChange={onFillChange}
        />
      )}
      {signature && signaturePlacement && (
        <SignatureOverlay
          viewport={rawViewport}
          scale={cssScale}
          signature={signature}
          placement={signaturePlacement}
          onMove={onMoveSignature}
        />
      )}
    </div>
  );
}

function MockPage({ zoom }: { zoom: number }) {
  return (
    <div
      className="pdf-page"
      style={{
        width: Math.round(595 * zoom),
        height: Math.round(842 * zoom),
        padding: `${Math.round(48 * zoom)}px ${Math.round(60 * zoom)}px`,
        display: "flex",
        flexDirection: "column",
        gap: `${Math.round(10 * zoom)}px`,
      }}
    >
      <div style={{ height: Math.round(16 * zoom), width: "70%", background: "var(--text-1)", borderRadius: 2, opacity: 0.85 }} />
      <div style={{ height: Math.round(8 * zoom), width: "100%", background: "var(--text-4)", borderRadius: 2 }} />
      <div style={{ height: Math.round(8 * zoom), width: "95%", background: "var(--text-4)", borderRadius: 2 }} />
      <div style={{ height: Math.round(8 * zoom), width: "98%", background: "var(--text-4)", borderRadius: 2 }} />
      <div style={{ height: Math.round(8 * zoom), width: "60%", background: "var(--text-4)", borderRadius: 2 }} />
      <div style={{ height: Math.round(20 * zoom) }} />
      <div style={{ height: Math.round(8 * zoom), width: "100%", background: "var(--text-4)", borderRadius: 2 }} />
      <div style={{ height: Math.round(8 * zoom), width: "92%", background: "var(--text-4)", borderRadius: 2 }} />
      <div style={{ height: Math.round(8 * zoom), width: "96%", background: "var(--text-4)", borderRadius: 2 }} />
      <div style={{ height: Math.round(8 * zoom), width: "75%", background: "var(--text-4)", borderRadius: 2 }} />
    </div>
  );
}

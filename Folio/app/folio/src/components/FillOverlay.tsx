import type { PageViewport } from "../lib/pdfjs";
import { pdfRectToCssRect } from "../lib/pdfjs";
import type { FillFieldWidget } from "../lib/formFields";

interface FillOverlayProps {
  viewport: PageViewport;
  scale: number;
  widgets: FillFieldWidget[];
  values: Record<string, string | boolean>;
  onChange: (fieldName: string, value: string | boolean) => void;
}

/** Renders live, interactive form inputs directly on top of a page's form
 * field widgets, so the user can actually type/check values in place. */
export function FillOverlay({ viewport, scale, widgets, values, onChange }: FillOverlayProps) {
  return (
    <div className="fill-overlay">
      {widgets.map((w) => {
        const css = pdfRectToCssRect(w.x, w.y, w.width, w.height, viewport, scale);
        const style = { left: css.x, top: css.y, width: css.width, height: css.height };
        if (w.kind === "text") {
          return (
            <input
              key={w.fieldName}
              className="fill-overlay__text"
              style={style}
              value={typeof values[w.fieldName] === "string" ? (values[w.fieldName] as string) : ""}
              onChange={(e) => onChange(w.fieldName, e.target.value)}
            />
          );
        }
        if (w.kind === "checkbox") {
          return (
            <input
              key={w.fieldName}
              type="checkbox"
              className="fill-overlay__checkbox"
              style={style}
              checked={!!values[w.fieldName]}
              onChange={(e) => onChange(w.fieldName, e.target.checked)}
            />
          );
        }
        return null;
      })}
    </div>
  );
}

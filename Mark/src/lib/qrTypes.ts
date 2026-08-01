// ============================================================
// Mark — lib/qrTypes.ts
// QR payload encoding for each supported type. The output is a
// plain string that the Rust `qrcode` crate encodes into a QR
// matrix. Encoding lives in the frontend so the live preview can
// recompute instantly on every keystroke without an IPC round
// trip for the format logic; only the final render goes to Rust.
// ============================================================

export type QrType =
  | "url"
  | "text"
  | "wifi"
  | "vcard"
  | "email"
  | "phone"
  | "sms"
  | "geo"
  | "calendar";

export interface QrTypeMeta {
  id: QrType;
  label: string;
  hint: string;
}

export const QR_TYPES: QrTypeMeta[] = [
  { id: "url", label: "URL", hint: "Link to a website" },
  { id: "text", label: "Text", hint: "Plain text or anything" },
  { id: "wifi", label: "WiFi", hint: "Connect to a network" },
  { id: "vcard", label: "vCard", hint: "Contact card" },
  { id: "email", label: "Email", hint: "Pre-filled message" },
  { id: "phone", label: "Phone", hint: "Dial a number" },
  { id: "sms", label: "SMS", hint: "Number + message" },
  { id: "geo", label: "Location", hint: "Map coordinates" },
  { id: "calendar", label: "Calendar", hint: "Event (vCalendar)" },
];

/** A single field in a type-specific form. */
export interface QrField {
  id: string;
  label: string;
  placeholder?: string;
  /** Optional select options — when present, the field renders as a <select>. */
  options?: { value: string; label: string }[];
  /** Optional default value. */
  defaultValue?: string;
  /** When true, render a textarea instead of an input. */
  multiline?: boolean;
}

export const QR_FIELDS: Record<QrType, QrField[]> = {
  url: [
    { id: "url", label: "URL", placeholder: "https://example.com", defaultValue: "https://" },
  ],
  text: [
    { id: "text", label: "Text", placeholder: "Anything you want to encode", multiline: true },
  ],
  wifi: [
    { id: "ssid", label: "Network name (SSID)", placeholder: "MyNetwork" },
    {
      id: "encryption",
      label: "Encryption",
      options: [
        { value: "WPA", label: "WPA/WPA2" },
        { value: "WEP", label: "WEP" },
        { value: "nopass", label: "No password" },
      ],
      defaultValue: "WPA",
    },
    { id: "password", label: "Password", placeholder: "••••••••" },
    { id: "hidden", label: "Hidden network?", options: [{ value: "false", label: "No" }, { value: "true", label: "Yes" }], defaultValue: "false" },
  ],
  vcard: [
    { id: "firstName", label: "First name", placeholder: "Ada" },
    { id: "lastName", label: "Last name", placeholder: "Lovelace" },
    { id: "org", label: "Organization", placeholder: "Analytical Engine Co." },
    { id: "title", label: "Title", placeholder: "Mathematician" },
    { id: "phone", label: "Phone", placeholder: "+1 555 555 5555" },
    { id: "email", label: "Email", placeholder: "ada@example.com" },
    { id: "url", label: "Website", placeholder: "https://example.com" },
  ],
  email: [
    { id: "to", label: "To", placeholder: "someone@example.com" },
    { id: "subject", label: "Subject", placeholder: "Hello" },
    { id: "body", label: "Body", placeholder: "Message text", multiline: true },
  ],
  phone: [
    { id: "number", label: "Phone number", placeholder: "+15555555555" },
  ],
  sms: [
    { id: "number", label: "Phone number", placeholder: "+15555555555" },
    { id: "message", label: "Message", placeholder: "Hey there", multiline: true },
  ],
  geo: [
    { id: "lat", label: "Latitude", placeholder: "37.7749" },
    { id: "lng", label: "Longitude", placeholder: "-122.4194" },
  ],
  calendar: [
    { id: "title", label: "Title / summary", placeholder: "Team sync" },
    { id: "location", label: "Location", placeholder: "Conference room A" },
    { id: "start", label: "Start", placeholder: "20250101T090000" },
    { id: "end", label: "End", placeholder: "20250101T100000" },
  ],
};

/** Escape special characters in a WiFi field per the WiFi QR spec. */
function wifiEscape(s: string): string {
  return s.replace(/([\\;,:"])/g, "\\$1");
}

/** Escape a vCard value: backslash, comma, newline. */
function vcardEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

function encodeURIComponentPart(s: string): string {
  return encodeURIComponent(s);
}

/**
 * Build the QR payload string from a type and its field values.
 * Returns "" when there is nothing meaningful to encode.
 */
export function encodeQrPayload(type: QrType, values: Record<string, string>): string {
  const get = (id: string) => (values[id] ?? "").trim();

  switch (type) {
    case "url": {
      const url = get("url");
      return url;
    }
    case "text": {
      return get("text");
    }
    case "wifi": {
      const ssid = get("ssid");
      const enc = get("encryption") || "WPA";
      const password = get("password");
      const hidden = get("hidden") === "true";
      if (!ssid) return "";
      const parts = [
        `T:${enc}`,
        `S:${wifiEscape(ssid)}`,
        enc === "nopass" ? "" : `P:${wifiEscape(password)}`,
        hidden ? "H:true" : "",
      ].filter(Boolean);
      return `WIFI:${parts.join(";")};;`;
    }
    case "vcard": {
      const first = get("firstName");
      const last = get("lastName");
      if (!first && !last) return "";
      const lines = [
        "BEGIN:VCARD",
        "VERSION:3.0",
        `N:${vcardEscape(last)};${vcardEscape(first)};;;`,
        `FN:${vcardEscape([first, last].filter(Boolean).join(" "))}`,
        get("org") ? `ORG:${vcardEscape(get("org"))}` : "",
        get("title") ? `TITLE:${vcardEscape(get("title"))}` : "",
        get("phone") ? `TEL;TYPE=CELL:${vcardEscape(get("phone"))}` : "",
        get("email") ? `EMAIL:${vcardEscape(get("email"))}` : "",
        get("url") ? `URL:${vcardEscape(get("url"))}` : "",
        "END:VCARD",
      ].filter(Boolean);
      return lines.join("\n");
    }
    case "email": {
      const to = get("to");
      if (!to) return "";
      const subject = get("subject");
      const body = get("body");
      const query = [
        subject ? `subject=${encodeURIComponentPart(subject)}` : "",
        body ? `body=${encodeURIComponentPart(body)}` : "",
      ].filter(Boolean).join("&");
      return `mailto:${to}${query ? `?${query}` : ""}`;
    }
    case "phone": {
      const number = get("number").replace(/\s+/g, "");
      return number ? `tel:${number}` : "";
    }
    case "sms": {
      const number = get("number").replace(/\s+/g, "");
      if (!number) return "";
      const message = get("message");
      return message ? `SMSTO:${number}:${message}` : `sms:${number}`;
    }
    case "geo": {
      const lat = get("lat");
      const lng = get("lng");
      if (!lat || !lng) return "";
      return `geo:${lat},${lng}`;
    }
    case "calendar": {
      const title = get("title");
      if (!title) return "";
      const location = get("location");
      const start = get("start");
      const end = get("end");
      const lines = [
        "BEGIN:VEVENT",
        `SUMMARY:${title}`,
        location ? `LOCATION:${location}` : "",
        start ? `DTSTART:${start}` : "",
        end ? `DTEND:${end}` : "",
        "END:VEVENT",
      ].filter(Boolean);
      return lines.join("\n");
    }
    default:
      return "";
  }
}

/** A human-readable summary of the encoded payload, for the recent list. */
export function payloadSummary(type: QrType, values: Record<string, string>): string {
  const get = (id: string) => (values[id] ?? "").trim();
  switch (type) {
    case "url": return get("url") || "URL";
    case "text": return get("text").slice(0, 40) || "Text";
    case "wifi": return get("ssid") ? `WiFi: ${get("ssid")}` : "WiFi";
    case "vcard": return [get("firstName"), get("lastName")].filter(Boolean).join(" ") || "Contact";
    case "email": return get("to") ? `Email → ${get("to")}` : "Email";
    case "phone": return get("number") ? `Tel ${get("number")}` : "Phone";
    case "sms": return get("number") ? `SMS ${get("number")}` : "SMS";
    case "geo": return (get("lat") && get("lng")) ? `${get("lat")}, ${get("lng")}` : "Location";
    case "calendar": return get("title") ? `Event: ${get("title")}` : "Calendar";
    default: return "QR";
  }
}

// Atlas document model (mirror of services/engine/atlas_engine/writer/atlasdoc.py).

export type TextType = "title" | "heading1" | "heading2" | "heading3" | "paragraph" | "quote" | "bullet" | "numbered";
export type BlockType = TextType | "table" | "pagebreak" | "image";
export type Align = "left" | "center" | "right" | "justify";

export interface Block { id: string; type: BlockType; html?: string; rows?: string[][]; align?: Align; src?: string; alt?: string; width?: number }
export interface AtlasDoc { format: "atlas.doc"; version: 1; title: string; page: { size: "A4" | "Letter" }; blocks: Block[] }

export const TEXT_TYPES: TextType[] = ["title", "heading1", "heading2", "heading3", "paragraph", "quote", "bullet", "numbered"];
export const STYLE_LABELS: Record<TextType, string> = {
  title: "Title", heading1: "Heading 1", heading2: "Heading 2", heading3: "Heading 3", paragraph: "Normal text",
  quote: "Quote", bullet: "Bulleted list", numbered: "Numbered list",
};

export const isText = (t: BlockType): t is TextType => (TEXT_TYPES as string[]).includes(t);
export const newId = () => "b" + Math.random().toString(16).slice(2, 12).padEnd(10, "0");
export const block = (type: BlockType, html = ""): Block =>
  type === "table" ? { id: newId(), type, rows: [["", ""], ["", ""]] } : type === "pagebreak" ? { id: newId(), type } : { id: newId(), type, html };

export function newDoc(title: string): AtlasDoc {
  return { format: "atlas.doc", version: 1, title, page: { size: "A4" }, blocks: [{ ...block("title"), html: escapeHtml(title) }, block("paragraph")] };
}

export const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const ALLOWED = new Set(["B", "I", "U", "S", "CODE", "SUB", "SUP", "BR", "A"]);
const RENAME: Record<string, string> = { STRONG: "B", EM: "I", STRIKE: "S", DEL: "S" };

/** '#rrggbb' from '#rrggbb', '#rgb' or 'rgb(r, g, b)'; null for anything else (same rules as the engine). */
export function hexColour(value: string | null | undefined): string | null {
  const v = (value ?? "").trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(v)) return v;
  if (/^#[0-9a-f]{3}$/.test(v)) return "#" + [...v.slice(1)].map((c) => c + c).join("");
  const m = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(v);
  if (m && [m[1], m[2], m[3]].every((x) => Number(x) <= 255) && (m[4] === undefined || Number(m[4]) > 0)) return "#" + [m[1], m[2], m[3]].map((x) => Number(x).toString(16).padStart(2, "0")).join("");
  return null;
}

/** Keep only the inline subset Atlas documents allow (same rules as the engine). */
export function sanitize(html: string): string {
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
  const walk = (node: Node): string => {
    let out = "";
    node.childNodes.forEach((c) => {
      if (c.nodeType === Node.TEXT_NODE) { out += escapeHtml(c.textContent ?? ""); return; }
      if (c.nodeType !== Node.ELEMENT_NODE) return;
      const el = c as Element;
      let tag = RENAME[el.tagName] ?? el.tagName;
      if (tag === "SCRIPT" || tag === "STYLE") return;
      // contentEditable may emit <span style="font-weight:bold"> etc.; map common ones
      if (tag === "SPAN" || tag === "FONT") {
        const st = (el as HTMLElement).style;
        let inner = walk(el);
        // Colour and highlight, in the same canonical form the engine writes.
        const color = hexColour(st?.color) ?? (tag === "FONT" ? hexColour(el.getAttribute("color")) : null);
        const bg = hexColour(st?.backgroundColor);
        const css = [color && `color: ${color}`, bg && `background-color: ${bg}`].filter(Boolean).join("; ");
        if (css && inner) inner = `<span style="${css}">${inner}</span>`;
        if (st?.fontWeight === "bold" || Number(st?.fontWeight) >= 600) inner = `<b>${inner}</b>`;
        if (st?.fontStyle === "italic") inner = `<i>${inner}</i>`;
        if (st?.textDecorationLine?.includes("underline")) inner = `<u>${inner}</u>`;
        out += inner; return;
      }
      if (!ALLOWED.has(tag)) { out += walk(el) + (tag === "DIV" || tag === "P" ? "<br>" : ""); return; }
      if (tag === "BR") { out += "<br>"; return; }
      if (tag === "A") {
        const href = el.getAttribute("href") ?? "";
        out += /^(https?:|mailto:)/i.test(href) ? `<a href="${href.replace(/"/g, "&quot;")}">${walk(el)}</a>` : walk(el);
        return;
      }
      tag = tag.toLowerCase();
      out += `<${tag}>${walk(el)}</${tag}>`;
    });
    return out;
  };
  return walk(doc.body.firstChild!).replace(/^(<br>)+|(<br>)+$/g, "");
}

export const plainText = (html = "") => new DOMParser().parseFromString(html.replace(/<br>/g, "\n"), "text/html").body.textContent ?? "";

export function wordCount(doc: AtlasDoc): number {
  let text = "";
  for (const b of doc.blocks) text += " " + (b.type === "table" ? (b.rows ?? []).flat().map(plainText).join(" ") : plainText(b.html));
  return (text.match(/[\p{L}\p{N}]+/gu) ?? []).length;
}

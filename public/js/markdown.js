// Assistant output is parsed with marked and sanitized with DOMPurify. Both
// libraries are served locally from the application's locked dependencies (see
// index.html and server/index.js), never from a third-party CDN.

const ALLOWED_TAGS = [
  "a", "blockquote", "br", "code", "del", "em", "h1", "h2", "h3", "h4", "h5", "h6",
  "hr", "img", "input", "li", "ol", "p", "pre", "strong", "table", "tbody", "td", "th",
  "thead", "tr", "ul",
];
const ALLOWED_ATTR = ["alt", "checked", "class", "disabled", "href", "src", "start", "title", "type"];

function escapeText(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[character]));
}

function decorateLinks(html) {
  if (typeof document === "undefined") return html;
  const template = document.createElement("template");
  template.innerHTML = html;
  for (const anchor of template.content.querySelectorAll("a[href]")) {
    anchor.setAttribute("target", "_blank");
    anchor.setAttribute("rel", "noopener noreferrer");
  }
  for (const table of template.content.querySelectorAll("table")) {
    const wrapper = document.createElement("div");
    wrapper.className = "markdown-table-wrap";
    table.replaceWith(wrapper);
    wrapper.append(table);
  }
  return template.innerHTML;
}

export function renderMarkdown(value) {
  const source = String(value ?? "");
  const parser = globalThis.marked;
  const purifier = globalThis.DOMPurify;
  // The libraries are loaded before the app module. Keep a safe, readable
  // fallback for a partially cached or otherwise broken asset load.
  if (typeof parser?.parse !== "function" || typeof purifier?.sanitize !== "function") {
    return source ? `<p>${escapeText(source).replace(/\n/g, "<br>")}</p>` : "";
  }

  const renderer = new parser.Renderer();
  // Raw HTML from a model response is not Markdown presentation and is never
  // passed through. DOMPurify remains the second line of defense for generated
  // markup and unsafe URLs.
  renderer.html = () => "";
  const parsed = parser.parse(source, { breaks: true, gfm: true, renderer });
  const sanitized = purifier.sanitize(parsed, {
    ALLOWED_ATTR,
    ALLOWED_TAGS,
    ALLOW_DATA_ATTR: false,
  });
  return decorateLinks(sanitized);
}

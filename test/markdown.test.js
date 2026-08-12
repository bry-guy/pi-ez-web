import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { marked } from "marked";
import createDOMPurify from "dompurify";
import { renderMarkdown } from "../public/js/markdown.js";

function withMarkdownDom(run) {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  const previous = {
    DOMPurify: globalThis.DOMPurify,
    document: globalThis.document,
    marked: globalThis.marked,
    window: globalThis.window,
  };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    marked,
    DOMPurify: createDOMPurify(dom.window),
  });
  try {
    return run(dom.window.document);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
    dom.window.close();
  }
}

test("assistant Markdown renders common GFM structures", () => withMarkdownDom(document => {
  const html = renderMarkdown(`# A pleasant response

A **strong** idea with _emphasis_, ~~a revision~~, and \`inline code\`.

- first point
- second point

> Helpful context lives here.

| Model | Status |
| --- | --- |
| Pi | Ready |

\`\`\`js
const answer = "rich";
\`\`\`

[Read the docs](https://example.com/docs).`);
  const root = document.createElement("div");
  root.innerHTML = html;

  assert.equal(root.querySelector("h1")?.textContent, "A pleasant response");
  assert.equal(root.querySelector("strong")?.textContent, "strong");
  assert.equal(root.querySelector("em")?.textContent, "emphasis");
  assert.equal(root.querySelector("del")?.textContent, "a revision");
  assert.equal(root.querySelector("ul")?.children.length, 2);
  assert.match(root.querySelector("blockquote")?.textContent || "", /Helpful context/);
  assert.equal(root.querySelectorAll("table th").length, 2);
  assert.equal(root.querySelector("pre code")?.textContent, 'const answer = "rich";\n');
  const link = root.querySelector("a[href='https://example.com/docs']");
  assert.ok(link);
  assert.equal(link.getAttribute("target"), "_blank");
  assert.equal(link.getAttribute("rel"), "noopener noreferrer");
}));

test("assistant Markdown drops raw HTML and sanitizes unsafe links", () => withMarkdownDom(document => {
  const html = renderMarkdown(`## Safety

<script>alert("no")</script>

![unsafe image](javascript:alert(1))

[unsafe link](javascript:alert(1))

<img src=x onerror="alert(1)">

[normal link](https://example.com/?q=one)`);
  const root = document.createElement("div");
  root.innerHTML = html;

  assert.equal(root.querySelector("script"), null);
  assert.equal(root.querySelector("[onerror]"), null);
  assert.equal(root.querySelector("a[href^='javascript:']"), null);
  assert.equal(root.querySelector("img[src^='javascript:']"), null);
  assert.equal(root.querySelector("a[href^='https://example.com']")?.textContent, "normal link");
}));

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttr(text) {
  return escapeHtml(text).replaceAll("`", "&#96;");
}

function safeLinkHref(href) {
  const value = String(href || "").trim();
  if (/^(https?:\/\/|\/|\.\/|\.\.\/|#)/i.test(value)) return value;
  return null;
}

function renderInline(text) {
  const parts = String(text).split(/(`[^`]*`)/g);
  return parts.map((part) => {
    if (part.startsWith("`") && part.endsWith("`")) {
      return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
    }
    let html = escapeHtml(part);
    html = html.replace(/(!?)\[([^\]]+)\]\(([^)]+)\)/g, (_, image, label, href) => {
      const safe = safeLinkHref(href);
      if (!safe) return label;
      const safeHref = escapeAttr(safe);
      if (image) return `<img src="${safeHref}" alt="${label}" class="markdown-image" loading="lazy">`;
      return `<a href="${safeHref}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    });
    html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");
    return html;
  }).join("");
}

function isCommentMarker(line) {
  return /^<!--\s*(BEGIN|END)\s+[^>]+-->$/.test(line.trim());
}

// Any other single-line HTML comment is authoring metadata, not reader content: generated-file
// banners ("do not edit directly") and package-ownership markers sit at the top of every rendered
// slash-command wrapper. They are invisible in a normal markdown viewer, so showing them here is a
// rendering artifact. Dropping them also keeps author-supplied HTML out of the output entirely --
// a workspace skill is user-authored content, and this renderer escapes rather than executes it.
function isDroppableComment(line) {
  const trimmed = line.trim();
  return trimmed.startsWith("<!--") && trimmed.endsWith("-->") && !isCommentMarker(trimmed);
}

// GitHub-style heading slug: lowercase, strip anything that isn't a word char/space/hyphen, spaces
// to hyphens, then dedupe repeats with a trailing -1/-2/... so deep links stay unambiguous within
// one rendered document.
export function slugify(text, seen) {
  const base = String(text)
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
  const count = seen.get(base) || 0;
  seen.set(base, count + 1);
  return count === 0 ? base : `${base}-${count}`;
}

// Fenced ```mermaid blocks render client-side via a vendored mermaid.js (portal/shared/vendor/
// mermaid.min.js — doc-guide-modal.js loads it lazily and calls mermaid.render() per block after
// this HTML is inserted, replacing each <pre class="mermaid"> with the resulting SVG).
// escapeHtml here is for HTML safety, not a fallback-only concern — mermaid.render() reads the
// raw source from data-mermaid-source, not the element's (HTML-escaped) textContent.
// data-mermaid-source keeps the raw text available so a failed render (offline, load error, bad
// diagram source) can still leave the escaped source visible instead of a blank box.
function renderMermaidFallback(source) {
  const escaped = escapeHtml(source);
  return `<div class="md-mermaid"><pre class="mermaid" data-mermaid-source="${escapeAttr(source)}">${escaped}</pre></div>`;
}

// GitHub-style pipe table: a header row, a `---|---` separator row, then body rows. Cells are split
// on unescaped `|`; a leading/trailing pipe on each line is optional and stripped if present.
function isTableSeparator(line) {
  return /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/.test(line) && line.includes("-");
}

function splitTableRow(line) {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

function renderTable(headerLine, bodyLines) {
  const headers = splitTableRow(headerLine);
  const rows = bodyLines.map(splitTableRow);
  const head = `<thead><tr>${headers.map((cell) => `<th>${renderInline(cell)}</th>`).join("")}</tr></thead>`;
  const body = `<tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${renderInline(cell)}</td>`).join("")}</tr>`).join("")}</tbody>`;
  return `<div class="md-table-wrap"><table>${head}${body}</table></div>`;
}

function renderCommentLine(line) {
  return `<p class="md-meta"><code>${escapeHtml(line.trim())}</code></p>`;
}

// GitHub task-list item: `- [ ] text` / `- [x] text`. Rendered as a disabled checkbox so a plan's
// checklist reads as state, not as literal "[x]" text -- the Plans drawer renders plan bodies that
// are mostly task checklists, and its previous private renderer showed them this way.
function renderListItem(item) {
  const task = /^\[([ xX])\]\s+(.*)$/.exec(item);
  if (!task) return `<li>${renderInline(item)}</li>`;
  const checked = task[1].toLowerCase() === "x";
  return `<li class="md-task"><input type="checkbox" disabled${checked ? " checked" : ""}> ${renderInline(task[2])}</li>`;
}

function renderList(items, ordered) {
  const tag = ordered ? "ol" : "ul";
  return `<${tag}>${items.map(renderListItem).join("")}</${tag}>`;
}

function renderBlocks(lines) {
  const blocks = [];
  const headingSlugs = new Map();
  let para = [];
  let list = null;
  let quote = [];
  let code = null;
  let codeLang = null;

  const flushPara = () => {
    if (!para.length) return;
    blocks.push(`<p>${renderInline(para.join(" "))}</p>`);
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    blocks.push(renderList(list.items, list.ordered));
    list = null;
  };
  const flushQuote = () => {
    if (!quote.length) return;
    blocks.push(`<blockquote>${quote.map((line) => `<p>${renderInline(line)}</p>`).join("")}</blockquote>`);
    quote = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.replace(/\s+$/, "");
    const trimmed = line.trim();

    if (code) {
      if (/^```/.test(trimmed)) {
        blocks.push(
          codeLang === "mermaid"
            ? renderMermaidFallback(code.join("\n"))
            : `<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`,
        );
        code = null;
        codeLang = null;
      } else {
        code.push(raw);
      }
      continue;
    }

    const fenceOpen = /^```(\S*)/.exec(trimmed);
    if (fenceOpen) {
      flushPara(); flushList(); flushQuote();
      code = [];
      codeLang = fenceOpen[1] || null;
      continue;
    }

    if (!trimmed) {
      flushPara(); flushList(); flushQuote();
      continue;
    }

    if (isCommentMarker(trimmed)) {
      flushPara(); flushList(); flushQuote();
      blocks.push(renderCommentLine(trimmed));
      continue;
    }

    if (isDroppableComment(trimmed)) {
      flushPara(); flushList(); flushQuote();
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      flushPara(); flushList(); flushQuote();
      const level = heading[1].length;
      const text = heading[2];
      const id = slugify(text.replace(/[`*_]/g, ""), headingSlugs);
      blocks.push(`<h${level} id="${id}">${renderInline(text)}</h${level}>`);
      continue;
    }

    // Table: a header row immediately followed by a `---|---` separator row. Only recognized at
    // this exact shape (GitHub's minimum), not arbitrary pipe-containing prose.
    if (line.includes("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1].trim())) {
      flushPara(); flushList(); flushQuote();
      const bodyLines = [];
      let j = i + 2;
      while (j < lines.length && lines[j].trim() && lines[j].includes("|")) {
        bodyLines.push(lines[j]);
        j += 1;
      }
      blocks.push(renderTable(trimmed, bodyLines));
      i = j - 1;
      continue;
    }

    if (/^>\s?/.test(trimmed)) {
      flushPara(); flushList();
      quote.push(trimmed.replace(/^>\s?/, ""));
      continue;
    }

    const ordered = /^(\d+)\.\s+(.+)$/.exec(trimmed);
    const unordered = /^[-*+]\s+(.+)$/.exec(trimmed);
    if (ordered || unordered) {
      flushPara(); flushQuote();
      const nextOrdered = !!ordered;
      const content = (ordered || unordered)[2] || (ordered || unordered)[1];
      if (!list || list.ordered !== nextOrdered) {
        flushList();
        list = { ordered: nextOrdered, items: [] };
      }
      list.items.push(content);
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flushPara(); flushList(); flushQuote();
      blocks.push("<hr />");
      continue;
    }

    flushList(); flushQuote();
    para.push(line);
  }

  if (code) {
    blocks.push(
      codeLang === "mermaid"
        ? renderMermaidFallback(code.join("\n"))
        : `<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`,
    );
  }
  flushPara(); flushList(); flushQuote();
  return blocks.join("\n");
}

export function renderMarkdown(text) {
  const normalized = String(text ?? "").replace(/\r\n/g, "\n");
  return renderBlocks(normalized.split("\n"));
}

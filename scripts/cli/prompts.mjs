import readline from "node:readline";

const SELECTED_TEXT_STYLE = "\x1b[1;36m";
const SELECTED_TAB_STYLE = "\x1b[1;46;30m";
const RESET_STYLE = "\x1b[0m";
const DIM_STYLE = "\x1b[38;5;245m";
const SUBTLE_STYLE = "\x1b[38;5;240m";

export function makePrompter() {
  if (!process.stdin.isTTY) return { ask: null, close() {} };
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return {
    ask: (q) => new Promise((res) => rl.question(q, (a) => res(a.trim()))),
    close: () => rl.close(),
  };
}

export async function confirmYesNo(prompter, question, def = true) {
  if (!prompter.ask) return def;
  const hint = def ? "[Y/n]" : "[y/N]";
  const a = (await prompter.ask(`${question} ${hint} `)).toLowerCase();
  if (a === "") return def;
  return a === "y" || a === "yes";
}

export async function askOverrideSkip(prompter, name, fallback = "skip") {
  if (!prompter.ask) return fallback;
  for (;;) {
    const a = (
      await prompter.ask(
        `  "${name}" already exists. (o)verride or (s)kip? [s] `,
      )
    ).toLowerCase();
    if (a === "" || a === "s" || a === "skip") return "skip";
    if (a === "o" || a === "override") return "override";
  }
}

export async function waitForAnyKey(message = "Press any key to continue") {
  const tty = process.stdin.isTTY && process.stdout.isTTY;
  if (!tty) return;
  process.stdout.write(`\n\x1b[1m${message}\x1b[0m`);
  return new Promise((resolve) => {
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const onKey = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("keypress", onKey);
      process.stdout.write("\n");
      resolve();
    };
    process.stdin.on("keypress", onKey);
  });
}

export async function waitForEnter(message = "Press Enter to continue") {
  const tty = process.stdin.isTTY && process.stdout.isTTY;
  if (!tty) return;
  process.stdout.write(`\n\x1b[1m${message}\x1b[0m`);
  return new Promise((resolve) => {
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const onKey = (_str, key) => {
      if (key?.name !== "return" && key?.name !== "enter") return;
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("keypress", onKey);
      process.stdout.write("\n");
      resolve();
    };
    process.stdin.on("keypress", onKey);
  });
}

export async function selectMenu(title, items) {
  const isHeader = (it) => Object.prototype.hasOwnProperty.call(it, "header");
  const selectable = items
    .map((it, i) => (isHeader(it) ? -1 : i))
    .filter((i) => i >= 0);
  const labelWidth = Math.max(
    ...items.filter((it) => !isHeader(it)).map((it) => it.label.length),
  );
  const columnGap = "    ";

  const tty = process.stdin.isTTY && process.stdout.isTTY;
  if (!tty) return numberedFallback(title, items, isHeader);

  return new Promise((resolve) => {
    let pos = 0;
    const out = process.stdout;
    const repaint = createRepaintRegion(out);

    const line = (it, sel, width, indent) => {
      if (isHeader(it))
        return `\x1b[38;5;67m${clipTerminalLine(`  ${it.header}`, width)}${RESET_STYLE}`;
      const pad = it.label.padEnd(labelWidth);
      const labelIndent = indent ? "  " : "";
      const marker = sel ? "> " : "  ";
      const head = `${labelIndent}${marker}${pad}`;
      const plain = clipTerminalLine(
        `${head}${it.desc ? `${columnGap}${it.desc}` : ""}`,
        width,
      );
      const headPart = plain.slice(0, head.length);
      const descPart = plain.slice(head.length);
      if (sel)
        return `${SELECTED_TEXT_STYLE}${headPart}${RESET_STYLE}${descPart ? `${DIM_STYLE}${descPart}${RESET_STYLE}` : ""}`;
      return `${headPart}${descPart ? `${DIM_STYLE}${descPart}${RESET_STYLE}` : ""}`;
    };

    const renderLines = (width) => {
      const lines = title.split("\n");
      if (lines.at(-1) === "") lines.pop();
      let indent = false;
      items.forEach((it, i) => {
        if (isHeader(it)) {
          lines.push("");
          lines.push(line(it, i === selectable[pos], width, false));
          indent = true;
          return;
        }
        lines.push(line(it, i === selectable[pos], width, indent));
      });
      return lines;
    };

    const render = () => {
      const width = terminalRenderWidth(out);
      repaint.render(renderLines(width));
    };

    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    render();

    const cleanup = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("keypress", onKey);
    };

    const onKey = (_str, key) => {
      if (!key) return;
      if (key.name === "up" || key.name === "k") {
        pos = (pos - 1 + selectable.length) % selectable.length;
        render();
      } else if (key.name === "down" || key.name === "j") {
        pos = (pos + 1) % selectable.length;
        render();
      } else if (key.name === "return" || key.name === "enter") {
        cleanup();
        out.write("\n");
        resolve(items[selectable[pos]].value);
      } else if (
        key.name === "escape" ||
        key.name === "q" ||
        (key.ctrl && key.name === "c")
      ) {
        cleanup();
        out.write("\n");
        resolve(null);
      }
    };

    process.stdin.on("keypress", onKey);
  });
}

export function terminalRenderWidth(out = process.stdout) {
  // Keep one spare column. Some terminals wrap when a write reaches the final column before "\n".
  return Math.max(1, (out.columns || 80) - 1);
}

export function clipTerminalLine(text, width) {
  return text.length <= width
    ? text
    : text.slice(0, Math.max(0, width - 1)) + "…";
}

export function moveListCursor(selectablePositions, cursor, direction, { wrap = false } = {}) {
  if (selectablePositions.length === 0) return -1;
  const at = selectablePositions.indexOf(cursor);
  if (at < 0) return selectablePositions[0];
  const next = at + direction;
  if (wrap) {
    return selectablePositions[(next + selectablePositions.length) % selectablePositions.length];
  }
  return selectablePositions[Math.max(0, Math.min(selectablePositions.length - 1, next))];
}

export function scrollListWindow({
  rowCount,
  selectedRow,
  viewportSize,
  scrollOffset = 0,
}) {
  const visibleSize = Math.max(0, Math.min(rowCount, viewportSize));
  if (rowCount === 0 || visibleSize === 0) {
    return { start: 0, end: 0, scrollOffset: 0, hasHiddenAbove: false, hasHiddenBelow: false };
  }

  let start = Math.max(0, Math.min(scrollOffset, rowCount - visibleSize));
  if (selectedRow >= 0 && selectedRow < start) start = selectedRow;
  if (selectedRow >= 0 && selectedRow >= start + visibleSize) {
    start = selectedRow - visibleSize + 1;
  }
  start = Math.max(0, Math.min(start, rowCount - visibleSize));

  return {
    start,
    end: start + visibleSize,
    scrollOffset: start,
    hasHiddenAbove: start > 0,
    hasHiddenBelow: start + visibleSize < rowCount,
  };
}

export function shouldUseScrollableBody({
  headerLineCount,
  bodyLineCount,
  footerLineCount,
  terminalHeight,
}) {
  const bodyViewportSize = Math.max(1, terminalHeight - headerLineCount - footerLineCount);
  return bodyLineCount > bodyViewportSize;
}

function bodyViewportSize({ headerLineCount, footerLineCount, terminalHeight }) {
  return Math.max(1, terminalHeight - headerLineCount - footerLineCount);
}

export function chooseWizardBodyLayout({
  maxSeparateRows,
  maxInlineRows,
  maxCompactRows,
  viewportSize,
}) {
  if (maxSeparateRows + 2 <= viewportSize) {
    return { compact: false, separateDescriptions: true };
  }
  if (maxInlineRows <= viewportSize) {
    return { compact: false, separateDescriptions: false };
  }
  return { compact: true, separateDescriptions: false, scroll: maxCompactRows > viewportSize };
}

function padViewportLines(lines, viewportSize) {
  const next = lines.slice(0, viewportSize);
  while (next.length < viewportSize) next.push("");
  return next;
}

function scrollableRows({
  rows,
  selectedRow,
  viewportSize,
  scrollOffset = 0,
  width,
}) {
  if (rows.length <= viewportSize) {
    return {
      lines: padViewportLines(rows.map((row) => row.line), viewportSize),
      scrollOffset: 0,
      hasHiddenAbove: false,
      hasHiddenBelow: false,
    };
  }

  if (viewportSize < 3) {
    const window = scrollListWindow({ rowCount: rows.length, selectedRow, viewportSize, scrollOffset });
    return {
      lines: padViewportLines(rows.slice(window.start, window.end).map((row) => row.line), viewportSize),
      scrollOffset: window.scrollOffset,
      hasHiddenAbove: window.hasHiddenAbove,
      hasHiddenBelow: window.hasHiddenBelow,
    };
  }

  let window = scrollListWindow({ rowCount: rows.length, selectedRow, viewportSize, scrollOffset });
  for (;;) {
    const indicatorCount = (window.hasHiddenAbove ? 1 : 0) + (window.hasHiddenBelow ? 1 : 0);
    const itemSlots = Math.max(1, viewportSize - indicatorCount);
    const next = scrollListWindow({
      rowCount: rows.length,
      selectedRow,
      viewportSize: itemSlots,
      scrollOffset: window.scrollOffset,
    });
    if (
      next.start === window.start &&
      next.end === window.end &&
      next.hasHiddenAbove === window.hasHiddenAbove &&
      next.hasHiddenBelow === window.hasHiddenBelow
    ) {
      window = next;
      break;
    }
    window = next;
  }

  const lines = [];
  if (window.hasHiddenAbove) lines.push(`${SUBTLE_STYLE}${clipTerminalLine("  ↑ more", width)}${RESET_STYLE}`);
  lines.push(...rows.slice(window.start, window.end).map((row) => row.line));
  if (window.hasHiddenBelow) lines.push(`${SUBTLE_STYLE}${clipTerminalLine("  ↓ more", width)}${RESET_STYLE}`);
  return {
    lines: padViewportLines(lines, viewportSize),
    scrollOffset: window.scrollOffset,
    hasHiddenAbove: window.hasHiddenAbove,
    hasHiddenBelow: window.hasHiddenBelow,
  };
}

export function createRepaintRegion(out = process.stdout) {
  let saved = false;

  return {
    render(lines) {
      if (!saved) {
        out.write("\x1b7");
        saved = true;
      } else {
        out.write("\x1b8\r");
      }
      out.write("\x1b[J");
      lines.forEach((line, i) => {
        const suffix = i === lines.length - 1 ? "" : "\n";
        out.write(`\r\x1b[2K${line}${suffix}`);
      });
    },
  };
}

function sectionTabs(steps, stepIdx, width) {
  const parts = steps.map((step, i) => {
    const label = ` ${shortStepTitle(step.title, width)} `;
    return i === stepIdx
      ? `${SELECTED_TAB_STYLE}${label}${RESET_STYLE}`
      : `${DIM_STYLE}${label}${RESET_STYLE}`;
  });
  return parts.join(" ");
}

function stepNavFooter(steps, stepIdx) {
  const prev = stepIdx > 0 ? "<- back" : "";
  const next =
    stepIdx < steps.length - 1
      ? `next to \x1b[1m${steps[stepIdx + 1].title}\x1b[0m ->`
      : "";
  return [prev, next, `Enter to \x1b[1mSave\x1b[0m`]
    .filter(Boolean)
    .join(" | ");
}

function menuLikeHeading(label) {
  const width = Math.max(44, label.length + 8);
  const side = Math.max(2, Math.floor((width - label.length - 2) / 2));
  const left = "=".repeat(side);
  const right = "=".repeat(width - label.length - side - 2);
  return `${left} ${label} ${right}`;
}

function shortStepTitle(title, width) {
  if (width < 72) {
    return (
      {
        "Code Conventions": "Conventions",
        "Chat-Time Output": "Chat Output",
      }[title] || title
    );
  }
  return title;
}

export function createStepWizardTemplate(options = {}) {
  const {
    title = "Package Library",
    escapeHint = "Esc - return to previous menu",
    browserCommand = "roborepo web",
    browserHint = "to do in the browser",
  } = options;

  return {
    headerLines({ steps, stepIdx, width }) {
      return [
        menuLikeHeading(`ROBOREPO : ${title}`),
        `${DIM_STYLE}${escapeHint}${RESET_STYLE}`,
        "",
        sectionTabs(steps, stepIdx, width),
        "",
        `\x1b[1m${clipTerminalLine(`Step ${stepIdx + 1}/${steps.length} · ${steps[stepIdx].title}`, width)}\x1b[0m`,
        "",
      ];
    },
    footerLines({ steps, stepIdx, width }) {
      return [
        "",
        clipTerminalLine("  --------------------", width),
        clipTerminalLine(`  ${stepNavFooter(steps, stepIdx)}`, width),
        "",
        `${SUBTLE_STYLE}  Run ${RESET_STYLE}\x1b[1m${browserCommand}\x1b[0m${SUBTLE_STYLE} ${browserHint}${RESET_STYLE}`,
      ];
    },
  };
}

export function terminalRenderHeight(out = process.stdout) {
  // Keep one spare row. Some terminals scroll when repainting the bottom row even without a trailing
  // newline, especially after an inherited interactive command starts below a prior menu frame.
  return Math.max(8, (out.rows || 24) - 1);
}

// Multi-step toggle wizard. One step (section) shown at a time; ←/→/Tab move between steps, ↑/↓ move
// the cursor within a step, Space toggles the highlighted item, Enter saves, Esc/q cancels.
//
// Space flips the item's `active` flag IN MEMORY only — instant, no I/O. The real install work is
// deferred: when the wizard exits it calls the optional `onFinish(steps)`, where the caller diffs each
// item's final `active` against its original and applies the changes in one batch. This keeps the raw-
// mode repaint loop free of blocking subprocesses and of any stray stdout (which would scroll the
// screen and break the cursor-up redraw math).
//
// steps: [{ title, hint?, readonly?, items: [{ label, description?, active, toggleable }] }]
// Read-only steps (or non-toggleable items) render but cannot flip. Non-TTY: returns immediately (the
// caller handles the headless path); the wizard is interactive-only.
//
// An item may instead be N-state (e.g. deny/ask/allow) by carrying `states: string[]` and
// `state` (current value, one of `states`) instead of `active`. Space cycles through `states` in
// order and wraps; boolean items (`active`, no `states`) are unaffected — this is a superset, not
// a replacement.
export async function wizard(steps, onFinish, options = {}) {
  const tty = process.stdin.isTTY && process.stdout.isTTY;
  if (!tty || steps.length === 0) return;

  const out = process.stdout;
  const repaint = createRepaintRegion(out);
  const template = options.template || createStepWizardTemplate(options);
  let stepIdx = 0;
  let cursor = 0;
  let scrollOffset = 0;

  const cursorablePositions = (step) =>
    step.items
      .map((it, i) => (it.toggleable && !step.readonly ? i : -1))
      .filter((i) => i >= 0);

  const clampCursor = (step) => {
    const sel = cursorablePositions(step);
    if (sel.length === 0) {
      cursor = -1;
      scrollOffset = 0;
      return;
    }
    if (cursor < 0 || !sel.includes(cursor)) cursor = sel[0];
  };

  const itemMark = (step, it) =>
    !it.toggleable || step.readonly
      ? "   "
      : it.states
        ? `[${it.state}]`.padEnd(
            Math.max(...it.states.map((s) => s.length)) + 2,
          )
        : it.active
          ? "[x]"
          : "[ ]";

  const itemLine = (step, it, i, width, { includeDescription = true } = {}) => {
    const sel = i === cursor;
    const mark = itemMark(step, it);
    // Compose the plain line first, truncate to width, then re-apply color — measuring plain text
    // keeps the visible length correct (ANSI escapes are zero-width).
    const head = `${sel ? "> " : "  "}${mark} ${it.label}`;
    const descSep = includeDescription && it.description ? "  " : "";
    const plain = clipTerminalLine(
      `${head}${descSep}${includeDescription ? it.description || "" : ""}`,
      width,
    );
    // Split back so the description stays dim and the selected row stays cyan.
    const headPart = plain.slice(0, head.length);
    const descPart = plain.slice(head.length);
    return sel
      ? `${SELECTED_TEXT_STYLE}${headPart}${RESET_STYLE}${descPart ? `${DIM_STYLE}${descPart}${RESET_STYLE}` : ""}`
      : `${headPart}${descPart ? `${DIM_STYLE}${descPart}${RESET_STYLE}` : ""}`;
  };

  const itemDescriptionIndent = (step, it, i) => {
    const marker = i === cursor ? "> " : "  ";
    return " ".repeat(`${marker}${itemMark(step, it)} `.length);
  };

  const buildBodyRows = (step, width, { compact = false, separateDescriptions = false } = {}) => {
    const rows = [];
    if (step.description) {
      rows.push({
        line: `\x1b[38;5;245m${clipTerminalLine(`  ${step.description}`, width)}\x1b[0m`,
      });
      if (!compact) rows.push({ line: "" });
    }
    if (step.notice) {
      rows.push({
        line: `\x1b[1m${clipTerminalLine(`  ${step.notice}`, width)}\x1b[0m`,
      });
      if (!compact) rows.push({ line: "" });
    }
    if (step.itemHeader && step.itemHeader !== step.title) {
      rows.push({
        line: `\x1b[1m${clipTerminalLine(`  ${step.itemHeader}`, width)}\x1b[0m`,
      });
      if (!compact) rows.push({ line: "" });
    }
    step.items.forEach((it, i) => {
      rows.push({
        line: itemLine(step, it, i, width, { includeDescription: !separateDescriptions }),
        itemIndex: i,
      });
      if (separateDescriptions && it.description) {
        rows.push({
          line: `${DIM_STYLE}${clipTerminalLine(`${itemDescriptionIndent(step, it, i)}${it.description}`, width)}${RESET_STYLE}`,
        });
      }
      if (!compact && i < step.items.length - 1) rows.push({ line: "" });
    });
    if (step.footnote) {
      if (!compact) rows.push({ line: "" });
      rows.push({
        line: `\x1b[38;5;245m${clipTerminalLine(`  ${step.footnote}`, width)}\x1b[0m`,
      });
    }
    return rows;
  };

  // Clip plain text to fit the terminal width so each rendered line occupies exactly one row; the
  // redraw math counts lines, not wrapped visual rows, so a wrapped line would drift the cursor.
  const render = () => {
    const step = steps[stepIdx];
    const width = terminalRenderWidth(out);
    const footer = template.footerLines({ steps, stepIdx, width });
    const lines = template.headerLines({ steps, stepIdx, width });
    const terminalHeight = terminalRenderHeight(out);
    const viewportSize = bodyViewportSize({
      headerLineCount: lines.length,
      footerLineCount: footer.length,
      terminalHeight,
    });
    const rowCounts = {
      maxSeparateRows: Math.max(...steps.map((candidate) =>
        buildBodyRows(candidate, width, { compact: false, separateDescriptions: true }).length
      )),
      maxInlineRows: Math.max(...steps.map((candidate) =>
        buildBodyRows(candidate, width, { compact: false, separateDescriptions: false }).length
      )),
      maxCompactRows: Math.max(...steps.map((candidate) =>
        buildBodyRows(candidate, width, { compact: true, separateDescriptions: false }).length
      )),
      viewportSize,
    };
    const layout = chooseWizardBodyLayout(rowCounts);
    const bodyRows = buildBodyRows(step, width, layout);
    const selectedRow = bodyRows.findIndex((row) => row.itemIndex === cursor);
    if (shouldUseScrollableBody({
      headerLineCount: lines.length,
      bodyLineCount: bodyRows.length,
      footerLineCount: footer.length,
      terminalHeight,
    })) {
      const body = scrollableRows({
        rows: bodyRows,
        selectedRow,
        viewportSize,
        scrollOffset,
        width,
      });
      scrollOffset = body.scrollOffset;
      lines.push(...body.lines);
    } else {
      scrollOffset = 0;
      lines.push(...padViewportLines(bodyRows.map((row) => row.line), viewportSize));
    }
    lines.push(...footer);

    repaint.render(lines);
  };

  clampCursor(steps[stepIdx]);

  return new Promise((resolve) => {
    let finished = false; // guard against double-finish (Enter then a queued key)
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    render();

    const onResize = () => {
      if (!finished) render();
    };
    out.on?.("resize", onResize);

    const cleanup = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("keypress", onKey);
      out.removeListener?.("resize", onResize);
      out.write("\n");
    };

    const finish = async ({ apply }) => {
      if (finished) return;
      finished = true;
      cleanup();
      const result = apply && onFinish ? await onFinish(steps) : { applied: false, changed: false };
      resolve(result);
    };

    const onKey = (_str, key) => {
      if (!key || finished) return;
      const step = steps[stepIdx];
      const sel = cursorablePositions(step);

      if (key.name === "left" || key.name === "h") {
        stepIdx = (stepIdx - 1 + steps.length) % steps.length;
        scrollOffset = 0;
        clampCursor(steps[stepIdx]);
        render();
      } else if (
        key.name === "right" ||
        key.name === "tab" ||
        key.name === "l"
      ) {
        stepIdx = (stepIdx + 1) % steps.length;
        scrollOffset = 0;
        clampCursor(steps[stepIdx]);
        render();
      } else if (key.name === "up" || key.name === "k") {
        if (sel.length) {
          cursor = moveListCursor(sel, cursor, -1, { wrap: false });
          render();
        }
      } else if (key.name === "down" || key.name === "j") {
        if (sel.length) {
          cursor = moveListCursor(sel, cursor, 1, { wrap: false });
          render();
        }
      } else if (key.name === "space") {
        const it = step.items[cursor];
        if (it && it.toggleable && !step.readonly) {
          // instant in-memory flip/cycle — real work deferred to onFinish, see wizard's header comment
          if (it.states)
            it.state =
              it.states[(it.states.indexOf(it.state) + 1) % it.states.length];
          else it.active = !it.active;
          render();
        }
      } else if (key.name === "return" || key.name === "enter") {
        void finish({ apply: true });
      } else if (
        key.name === "escape" ||
        key.name === "q" ||
        (key.ctrl && key.name === "c")
      ) {
        void finish({ apply: false });
      }
    };

    process.stdin.on("keypress", onKey);
  });
}

function numberedFallback(title, items, isHeader) {
  console.log(title);
  const order = [];
  for (const it of items) {
    if (isHeader(it)) {
      console.log(`\n  ${it.header}`);
    } else {
      order.push(it);
      const desc = it.desc ? `  — ${it.desc}` : "";
      console.log(`  ${order.length}) ${it.label}${desc}`);
    }
  }
  process.stdout.write("Select a number (or blank to cancel): ");

  const interactive = process.stdin.isTTY;
  const rl = readline.createInterface({ input: process.stdin });
  return new Promise((resolve) => {
    let captured = null;
    let settled = false;
    const toValue = (l) => {
      const n = Number.parseInt(l, 10);
      return Number.isInteger(n) && n >= 1 && n <= order.length
        ? order[n - 1].value
        : null;
    };
    const finish = (val) => {
      if (settled) return;
      settled = true;
      rl.close();
      resolve(val);
    };
    rl.once("line", (l) => {
      captured = l;
      if (interactive) finish(toValue(l));
    });
    rl.once("close", () =>
      finish(captured === null ? null : toValue(captured)),
    );
  });
}

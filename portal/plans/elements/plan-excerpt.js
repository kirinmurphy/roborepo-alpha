// The description on every plan card and Prioritize row: a preview that, after a sustained hover, reads on to
// twice its length. The longer text lays over whatever follows, so nothing below it moves.
const PREVIEW_LENGTH = 190;
const EXPANDED_LENGTH = PREVIEW_LENGTH * 2;
const EXPAND_DELAY_MS = 1000;

// `region` is the element that holds the description, grows over the page, and takes the hover.
export function renderPlanExcerpt(description, region, excerpt) {
  const preview = cutAtWord(excerpt, PREVIEW_LENGTH);
  if (preview.length === excerpt.length) {
    description.textContent = excerpt;
    return;
  }
  const longer = cutAtWord(excerpt, EXPANDED_LENGTH);
  const head = document.createTextNode(preview);
  const ellipsis = span("plan-excerpt-ellipsis", "…");
  const more = span("plan-excerpt-more", `${longer.slice(preview.length)}${longer.length < excerpt.length ? "…" : ""}`);
  description.replaceChildren(head, ellipsis);

  let timer;
  const expand = () => {
    // Unrounded, or a card of fractional height would nudge what follows by half a pixel.
    const height = region.getBoundingClientRect().height;
    description.replaceChildren(head, more);
    // The stylesheet takes this growth back out of the region's bottom margin, which is what keeps
    // everything after it in place.
    region.style.setProperty("--excerpt-growth", `${region.getBoundingClientRect().height - height}px`);
    region.classList.add("is-excerpt-expanded");
  };
  const collapse = () => {
    clearTimeout(timer);
    description.replaceChildren(head, ellipsis);
    region.classList.remove("is-excerpt-expanded");
    region.style.removeProperty("--excerpt-growth");
  };
  region.addEventListener("pointerenter", (event) => {
    // A touch has no hover to sustain; the drawer shows the description in full.
    if (event.pointerType === "touch") return;
    clearTimeout(timer);
    timer = setTimeout(expand, EXPAND_DELAY_MS);
  });
  region.addEventListener("pointerleave", collapse);
  region.addEventListener("click", collapse);
}

// Cut between words, so the preview's last word is the same word once the text reads on, and its
// line breaks stay where they were.
function cutAtWord(text, maxLength) {
  if (text.length <= maxLength) return text;
  const space = text.lastIndexOf(" ", maxLength);
  return text.slice(0, space > 0 ? space : maxLength).trimEnd();
}

function span(className, text) {
  const node = document.createElement("span");
  node.className = className;
  node.textContent = text;
  return node;
}

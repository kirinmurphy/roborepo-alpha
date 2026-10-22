// Format the native hook names and settings route consistently in notices and their tooltips.
export function formatHookReferences(root) {
  for (const template of root.querySelectorAll("template")) formatHookReferences(template.content);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const texts = [];
  while (walker.nextNode()) texts.push(walker.currentNode);
  for (const text of texts) {
    if (text.parentElement?.closest("code")) continue;
    const parts = text.textContent.split(/(SessionStart|PreToolUse|Settings → Hooks)/g);
    if (parts.length === 1) continue;
    text.replaceWith(...parts.map((part, index) => {
      if (index % 2 === 0) return document.createTextNode(part);
      const code = document.createElement("code");
      code.textContent = part;
      return code;
    }));
  }
}

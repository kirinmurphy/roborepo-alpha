// Path-based edits on a JSON root config (Claude and Gemini settings.json). Text in, text out: the
// caller reads the file and writes the result through its own tracked writer. A path is an array
// of keys, so a key containing a dot or "@" (enabledPlugins["caveman@caveman"]) needs no escaping.

function parse(text) {
  if (!text || !text.trim()) return {};
  const value = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("JSON root config must be an object");
  return value;
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function render(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function getJsonValue(text, keyPath) {
  let node = parse(text);
  for (const key of keyPath) {
    if (!isPlainObject(node) || !Object.hasOwn(node, key)) return { found: false, value: undefined };
    node = node[key];
  }
  return { found: true, value: node };
}

export function setJsonValue(text, keyPath, value) {
  const root = parse(text);
  let node = root;
  for (const key of keyPath.slice(0, -1)) {
    if (!Object.hasOwn(node, key)) node[key] = {};
    if (!isPlainObject(node[key])) throw new Error(`cannot set ${keyPath.join(".")}: ${key} is not an object`);
    node = node[key];
  }
  node[keyPath.at(-1)] = value;
  return render(root);
}

// Removes the key, then any parent object the removal left empty, so disabling a package does not
// leave `"env": {}` behind.
export function deleteJsonValue(text, keyPath) {
  const root = parse(text);
  const chain = [root];
  for (const key of keyPath.slice(0, -1)) {
    const next = chain.at(-1)[key];
    if (!isPlainObject(next)) return text;
    chain.push(next);
  }
  const parent = chain.at(-1);
  if (!Object.hasOwn(parent, keyPath.at(-1))) return text;
  delete parent[keyPath.at(-1)];
  for (let depth = chain.length - 1; depth > 0; depth -= 1) {
    if (Object.keys(chain[depth]).length > 0) break;
    delete chain[depth - 1][keyPath[depth - 1]];
  }
  return render(root);
}

export const jsonConfigEdit = Object.freeze({ get: getJsonValue, set: setJsonValue, delete: deleteJsonValue });

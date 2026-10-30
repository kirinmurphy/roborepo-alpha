import fs from "node:fs";
import path from "node:path";
import { slugify } from "../cli/markdown-render.mjs";

const PATH_ROOTS = "modules|portal|scripts|globals|manifests|generated|docs|bin|shell|local";
const PATH_CODE = new RegExp(`\x60((?:${PATH_ROOTS})/[^\x60\\s]+)\x60`, "g");
const INLINE_LINK = /!?\[[^\]]*\]\((<[^>]+>|(?:[^()\s]|\([^()\s]*\))+)(?:\s+\"[^\"]*\")?\)/g;
const REFERENCE_LINK = /!?\[([^\]]+)\]\[([^\]]*)\]/g;
const SHORTCUT_LINK = /(?<!\\)\[([^\]]+)\]/g;
const REFERENCE_DEFINITION = /^\s*\[([^\]]+)\]:\s*(<[^>]+>|\S+)/;
const HISTORICAL = /\b(?:no longer exists?|does not exist|do not exist|there is no|did not exist|never (?:existed|written)|removed|deleted|retired|previously|formerly|historical|dated|legacy|proposed|candidate|old path|before migration|was replaced|were replaced|superseded|no .+ candidate exists)\b/i;

export function readerDocs(root) {
  const files = ["README.md", "manifests/inventory/README.md"];
  walk(path.join(root, "docs"), (absolute) => {
    const relative = path.relative(root, absolute).replaceAll(path.sep, "/");
    if (!relative.startsWith("docs/plans/") && relative.endsWith(".md")) files.push(relative);
  });
  return files.filter((file) => fs.existsSync(path.join(root, file))).sort();
}

export function scanDocs(root, files = readerDocs(root)) {
  const findings = [];
  for (const file of files) {
    const absolute = path.join(root, file);
    const lines = fs.readFileSync(absolute, "utf8").split(/\r?\n/);
    const refs = referenceDefinitions(lines);
    const datedSnapshot = lines.slice(0, 5).some((line) => /^Snapshot date:/i.test(line));
    let fence = null;
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      const marker = fenceMarker(line);
      if (!fence && marker) {
        fence = marker;
        continue;
      }
      if (fence && marker && closesFence(marker, fence)) {
        fence = null;
        continue;
      }
      if (!fence) {
        const prose = line.replace(/\x60[^\x60]*\x60/g, "");
        for (const match of prose.matchAll(INLINE_LINK)) {
          checkLink(root, file, index + 1, match[1], findings);
        }
        if (!REFERENCE_DEFINITION.test(prose)) {
          for (const match of prose.matchAll(REFERENCE_LINK)) {
            const id = (match[2] || match[1]).toLowerCase().replace(/\s+/g, " ");
            if (refs.has(id)) checkLink(root, file, index + 1, refs.get(id), findings);
            else findings.push({ file, line: index + 1, reason: `missing reference definition [${id}]` });
          }
          const shortcuts = prose.replace(INLINE_LINK, "").replace(REFERENCE_LINK, "");
          for (const match of shortcuts.matchAll(SHORTCUT_LINK)) {
            const id = match[1].toLowerCase().replace(/\s+/g, " ");
            if (refs.has(id)) checkLink(root, file, index + 1, refs.get(id), findings);
          }
        }
        if (!datedSnapshot) {
          for (const match of line.matchAll(PATH_CODE)) {
            if (!historicalClause(line, match.index)) checkPath(root, file, index + 1, match[1], findings);
          }
        }
      }
    }
  }
  return findings;
}

function walk(dir, visit) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(absolute, visit);
    else if (entry.isFile()) visit(absolute);
  }
}

function referenceDefinitions(lines) {
  const refs = new Map();
  let fence = null;
  for (const line of lines) {
    const marker = fenceMarker(line);
    if (!fence && marker) { fence = marker; continue; }
    if (fence && marker && closesFence(marker, fence)) { fence = null; continue; }
    if (fence) continue;
    const match = REFERENCE_DEFINITION.exec(line);
    if (match) refs.set(match[1].toLowerCase().replace(/\s+/g, " "), match[2]);
  }
  return refs;
}

function checkLink(root, file, line, rawTarget, findings) {
  const target = rawTarget.replace(/^<|>$/g, "");
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/|\/)/i.test(target)) return;
  const [withoutFragment, fragment = ""] = target.split("#", 2);
  const pathname = withoutFragment.split("?", 1)[0];
  let decoded;
  try { decoded = decodeURIComponent(pathname); }
  catch { findings.push({ file, line, reason: `invalid link encoding: ${target}` }); return; }
  const resolved = path.resolve(root, path.dirname(file), decoded || path.basename(file));
  if (!resolved.startsWith(`${root}${path.sep}`) && resolved !== root) {
    findings.push({ file, line, reason: `link escapes repository: ${target}` }); return;
  }
  if (!fs.existsSync(resolved)) {
    findings.push({ file, line, reason: `missing link target: ${target}` }); return;
  }
  let decodedFragment;
  try { decodedFragment = decodeURIComponent(fragment); }
  catch { findings.push({ file, line, reason: `invalid link encoding: ${target}` }); return; }
  if (decodedFragment && resolved.endsWith(".md") && !anchors(resolved).has(decodedFragment)) {
    findings.push({ file, line, reason: `missing anchor: ${target}` });
  }
}

function anchors(file) {
  const found = new Set();
  const seen = new Map();
  let fence = null;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const marker = fenceMarker(line);
    if (!fence && marker) { fence = marker; continue; }
    if (fence && marker && closesFence(marker, fence)) { fence = null; continue; }
    if (fence) continue;
    const heading = /^\s*#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) found.add(slugify(heading[1].replace(/[`*_]/g, ""), seen));
  }
  return found;
}

function fenceMarker(line) {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  return match && { marker: match[1], rest: match[2] };
}

function closesFence(marker, opening) {
  return marker.marker[0] === opening.marker[0]
    && marker.marker.length >= opening.marker.length
    && !marker.rest.trim();
}

function checkPath(root, file, line, raw, findings) {
  const cited = raw.replace(/[.,;:]$/, "");
  if (/[<>{}*$?]/.test(cited)) return;
  const pathname = cited.split("#", 1)[0].replace(/:\d+(?:-\d+)?$/, "");
  if (!fs.existsSync(path.join(root, pathname))) {
    findings.push({ file, line, reason: `missing repository path: ${cited}` });
  }
}

function historicalClause(line, offset) {
  // An obsolete path and its current replacement can share one Markdown line. A historical
  // qualifier applies to its own clause, not automatically to the replacement after a semicolon.
  const before = line.slice(0, offset);
  const boundary = Math.max(before.lastIndexOf(";"), before.lastIndexOf(" — "));
  const after = line.slice(offset);
  const next = /;| — /.exec(after);
  return HISTORICAL.test(line.slice(boundary + 1, next ? offset + next.index : undefined));
}

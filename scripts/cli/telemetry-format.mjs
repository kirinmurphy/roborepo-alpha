export function formatCount(value) {
  return Number(value || 0).toLocaleString("en-US");
}

export function clipText(value, length) {
  return value && value.length > length ? value.slice(0, length) + "…" : value || "";
}

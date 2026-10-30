#!/usr/bin/env node
// Unit test for the onboarding wizard's deferred-apply selection (presets.pendingWizardChanges).
// The wizard flips each item's `active` flag in memory during the keypress loop; when it exits, only
// the rows whose `active` differs from the original `wasActive` should be applied. This exercises
// that pure diff directly — no pty, no config mutation — so it stays fast and non-brittle. The
// end-to-end keypress -> apply -> persisted-mutation path is covered by the pty test in
// test-install-collisions.sh (test_onboarding_wizard_toggles_and_applies).
import assert from "node:assert/strict";
import { pendingWizardChanges } from "../cli/presets.mjs";
import {
  chooseWizardBodyLayout,
  moveListCursor,
  scrollListWindow,
  shouldUseScrollableBody,
  terminalRenderHeight,
} from "../cli/prompts.mjs";

const row = (id, { active, wasActive, toggleable = true, category = "Token Optimization" }) => ({
  label: id,
  active,
  wasActive,
  toggleable,
  section: { category },
  item: { id },
});

// N-state (deny/ask/allow) row — same shape the Permissions step's named-behavior toggles use.
const stateRow = (id, { state, wasState, toggleable = true }) => ({
  label: id,
  states: ["deny", "ask", "allow"],
  state,
  wasState,
  toggleable,
  item: { id },
});

const steps = [
  {
    title: "Token Optimization",
    items: [
      row("caveman", { active: false, wasActive: true }),  // changed -> disable
      row("telemetry", { active: true, wasActive: true }),    // unchanged -> skip
    ],
  },
  {
    title: "Commands",
    items: [
      row("verify", { active: true, wasActive: false, category: "Commands" }),            // changed -> enable
      row("frozen", { active: true, wasActive: false, toggleable: false, category: "Commands" }), // not toggleable -> skip
    ],
  },
  {
    title: "Permissions",
    items: [
      stateRow("delete-files", { state: "allow", wasState: "ask" }), // changed -> pending
      stateRow("go-online", { state: "deny", wasState: "deny" }),    // unchanged -> skip
    ],
  },
];

const pending = pendingWizardChanges(steps);

assert.deepEqual(
  pending.map((r) => r.item.id),
  ["caveman", "verify", "delete-files"],
  "selects only changed, toggleable rows (boolean active or N-state), in order",
);
assert.equal(pending[0].active, false, "carries the desired final state for a disable");
assert.equal(pending[1].active, true, "carries the desired final state for an enable");
assert.equal(pending[2].state, "allow", "carries the desired final state for an N-state change");

// No changes -> empty selection (the 'No changes.' path).
const unchanged = pendingWizardChanges([
  { title: "x", items: [row("caveman", { active: true, wasActive: true })] },
]);
assert.equal(unchanged.length, 0, "an all-unchanged wizard yields no pending work");

// A readonly step is skipped entirely, even if an item's value differs from its original.
const readonlySkipped = pendingWizardChanges([
  { title: "x", readonly: true, items: [row("frozen", { active: false, wasActive: true })] },
]);
assert.equal(readonlySkipped.length, 0, "a readonly step's items are never pending, even if changed");

assert.equal(
  moveListCursor([2, 5, 8], 2, -1),
  2,
  "wizard list navigation clamps at the first row",
);
assert.equal(
  moveListCursor([2, 5, 8], 8, 1),
  8,
  "wizard list navigation clamps at the last row",
);
assert.equal(
  moveListCursor([2, 5, 8], 2, -1, { wrap: true }),
  8,
  "reusable list navigation still supports explicit wraparound",
);

assert.deepEqual(
  scrollListWindow({ rowCount: 10, selectedRow: 0, viewportSize: 4, scrollOffset: 0 }),
  { start: 0, end: 4, scrollOffset: 0, hasHiddenAbove: false, hasHiddenBelow: true },
  "scroll window reports hidden rows below the first viewport",
);
assert.deepEqual(
  scrollListWindow({ rowCount: 10, selectedRow: 7, viewportSize: 4, scrollOffset: 0 }),
  { start: 4, end: 8, scrollOffset: 4, hasHiddenAbove: true, hasHiddenBelow: true },
  "scroll window follows selection downward",
);
assert.deepEqual(
  scrollListWindow({ rowCount: 10, selectedRow: 2, viewportSize: 4, scrollOffset: 6 }),
  { start: 2, end: 6, scrollOffset: 2, hasHiddenAbove: true, hasHiddenBelow: true },
  "scroll window follows selection upward",
);
assert.equal(
  shouldUseScrollableBody({
    headerLineCount: 7,
    bodyLineCount: 10,
    footerLineCount: 5,
    terminalHeight: 22,
  }),
  false,
  "wizard uses static rendering when header, body, and footer fit",
);
assert.equal(
  shouldUseScrollableBody({
    headerLineCount: 7,
    bodyLineCount: 11,
    footerLineCount: 5,
    terminalHeight: 22,
  }),
  true,
  "wizard scrolls only when the full frame would overflow",
);
assert.equal(
  terminalRenderHeight({ rows: 16 }),
  15,
  "wizard keeps one spare row so the header stays visible at the terminal boundary",
);
assert.equal(
  shouldUseScrollableBody({
    headerLineCount: 7,
    bodyLineCount: 5,
    footerLineCount: 5,
    terminalHeight: terminalRenderHeight({ rows: 16 }),
  }),
  true,
  "a step change that exceeds the pinned body viewport uses scroll mode",
);
assert.deepEqual(
  chooseWizardBodyLayout({
    maxSeparateRows: 12,
    maxInlineRows: 8,
    maxCompactRows: 6,
    viewportSize: 16,
  }),
  { compact: false, separateDescriptions: true },
  "wizard uses separate description rows only when every section has spare room",
);
assert.deepEqual(
  chooseWizardBodyLayout({
    maxSeparateRows: 18,
    maxInlineRows: 8,
    maxCompactRows: 6,
    viewportSize: 10,
  }),
  { compact: false, separateDescriptions: false },
  "wizard keeps inline descriptions for every section when the largest separate layout is too tall",
);
assert.deepEqual(
  chooseWizardBodyLayout({
    maxSeparateRows: 20,
    maxInlineRows: 14,
    maxCompactRows: 11,
    viewportSize: 10,
  }),
  { compact: true, separateDescriptions: false, scroll: true },
  "wizard uses the same compact scrolling layout for all sections when the largest list overflows",
);

console.log("wizard-diff ok");

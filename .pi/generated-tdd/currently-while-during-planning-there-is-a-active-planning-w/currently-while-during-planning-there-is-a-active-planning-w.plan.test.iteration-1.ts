// Generated from a markdown plan.
import test from "node:test";
import assert from "node:assert/strict";

import planFeatureExtension, { __testables } from "../../extensions/plan-feature.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePlanningState(overrides: Record<string, unknown> = {}) {
  return {
    active: true,
    originId: "leaf-1",
    id: "plan-1",
    title: "Better planning message",
    slug: "better-planning-message",
    originalInput: "Better planning message",
    status: "collecting-context",
    repoRoot: "/repo",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    relevantFiles: [],
    questions: [],
    assumptions: [],
    decisions: [],
    ...overrides,
  };
}

type Notice = { level: string; message: string };

function makeCtx(overrides: Record<string, unknown> = {}) {
  const entryLog: Array<{ type: string; value: unknown }> = [];
  const notices: Notice[] = [];
  return {
    state: {},
    notices,
    entryLog,
    pi: {
      appendEntry(entry: { type: string; value: unknown }) {
        entryLog.push(entry);
        return { id: `entry-${entryLog.length}` };
      },
      notify(message: string) {
        notices.push({ level: "info", message });
      },
      warn(message: string) {
        notices.push({ level: "warn", message });
      },
      error(message: string) {
        notices.push({ level: "error", message });
      },
      ask: async (_prompt: string) => "yes",
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// ANSI escape helpers
// ---------------------------------------------------------------------------
const ESC = "\x1b[";
const YELLOW_FG = `${ESC}33m`;
const RED_FG = `${ESC}31m`;
const BOLD = `${ESC}1m`;
const RESET = `${ESC}0m`;

// Matches any ANSI yellow (foreground 33, or 38;5;3, or 38;2;... yellow-ish)
function containsYellowAnsi(text: string): boolean {
  return /\x1b\[33m/.test(text) || /\x1b\[38;5;(?:3|11|226|220)m/.test(text) || /\x1b\[93m/.test(text);
}

function containsRedAnsi(text: string): boolean {
  return /\x1b\[31m/.test(text) || /\x1b\[38;5;(?:1|9|196)m/.test(text) || /\x1b\[91m/.test(text);
}

function containsBorderChars(text: string): boolean {
  // Box-drawing or repeated dash/equal border patterns
  return (
    /[─━╔╗╚╝║┌┐└┘┃╭╮╰╯]/.test(text) ||
    /[\-=]{3,}/.test(text)
  );
}

function containsHighVisibilityColor(text: string): boolean {
  return containsYellowAnsi(text) || containsRedAnsi(text);
}

// ---------------------------------------------------------------------------
// Tests – active planning warning visibility
// ---------------------------------------------------------------------------

test("active planning warning text uses yellow or red ANSI color codes so it is highly visible", async () => {
  // The plan-feature extension (or whichever module renders the active-planning
  // banner) must produce styled output when a planning session is active.
  // We look for a function that formats/renders the planning banner.

  // First, verify __testables exposes a banner/warning formatter
  const formatBanner =
    __testables.formatPlanningBanner ??
    __testables.renderPlanningWarning ??
    __testables.formatActivePlanningMessage ??
    __testables.getPlanningBanner;

  assert.ok(
    formatBanner,
    "Expected __testables to expose a planning-banner formatting function (e.g. formatPlanningBanner, renderPlanningWarning, formatActivePlanningMessage, or getPlanningBanner)",
  );

  const planningState = makePlanningState();
  const banner: string = typeof formatBanner === "function" ? formatBanner(planningState) : String(formatBanner);

  assert.ok(
    containsHighVisibilityColor(banner),
    `Expected the active-planning banner to contain yellow or red ANSI escape codes for visibility, but got:\n${JSON.stringify(banner)}`,
  );
});

test("active planning warning is enclosed in visible borders (box-drawing or repeated dashes)", async () => {
  const formatBanner =
    __testables.formatPlanningBanner ??
    __testables.renderPlanningWarning ??
    __testables.formatActivePlanningMessage ??
    __testables.getPlanningBanner;

  assert.ok(formatBanner, "Expected a planning-banner formatting function to be exported from __testables");

  const planningState = makePlanningState();
  const banner: string = typeof formatBanner === "function" ? formatBanner(planningState) : String(formatBanner);

  assert.ok(
    containsBorderChars(banner),
    `Expected the active-planning banner to be enclosed in visible borders (box-drawing characters or repeated dashes), but got:\n${JSON.stringify(banner)}`,
  );
});

test("active planning warning contains the planning session title for context", async () => {
  const formatBanner =
    __testables.formatPlanningBanner ??
    __testables.renderPlanningWarning ??
    __testables.formatActivePlanningMessage ??
    __testables.getPlanningBanner;

  assert.ok(formatBanner, "Expected a planning-banner formatting function to be exported from __testables");

  const planningState = makePlanningState({ title: "My Unique Plan Title" });
  const banner: string = typeof formatBanner === "function" ? formatBanner(planningState) : String(formatBanner);

  // Strip ANSI codes for content matching
  const plain = banner.replace(/\x1b\[[0-9;]*m/g, "");
  assert.ok(
    plain.includes("My Unique Plan Title"),
    `Expected the banner to include the planning session title 'My Unique Plan Title', got:\n${plain}`,
  );
});

test("active planning warning includes a recognisable 'active planning' or 'planning session' label", async () => {
  const formatBanner =
    __testables.formatPlanningBanner ??
    __testables.renderPlanningWarning ??
    __testables.formatActivePlanningMessage ??
    __testables.getPlanningBanner;

  assert.ok(formatBanner, "Expected a planning-banner formatting function to be exported from __testables");

  const planningState = makePlanningState();
  const banner: string = typeof formatBanner === "function" ? formatBanner(planningState) : String(formatBanner);

  const plain = banner.replace(/\x1b\[[0-9;]*m/g, "").toLowerCase();
  const hasLabel =
    plain.includes("active planning") ||
    plain.includes("planning session") ||
    plain.includes("planning active") ||
    plain.includes("⚠") ||
    plain.includes("warning");

  assert.ok(
    hasLabel,
    `Expected the banner to contain a recognisable planning-active label (e.g. 'active planning', 'planning session'), got:\n${plain}`,
  );
});

test("edge case: banner still renders with color and borders when planning title is empty", async () => {
  const formatBanner =
    __testables.formatPlanningBanner ??
    __testables.renderPlanningWarning ??
    __testables.formatActivePlanningMessage ??
    __testables.getPlanningBanner;

  assert.ok(formatBanner, "Expected a planning-banner formatting function to be exported from __testables");

  const planningState = makePlanningState({ title: "" });
  const banner: string = typeof formatBanner === "function" ? formatBanner(planningState) : String(formatBanner);

  assert.ok(
    containsHighVisibilityColor(banner),
    "Expected yellow/red ANSI codes even when planning title is empty",
  );
  assert.ok(
    containsBorderChars(banner),
    "Expected border characters even when planning title is empty",
  );
});

test("edge case: no banner is produced when planning session is inactive", async () => {
  const formatBanner =
    __testables.formatPlanningBanner ??
    __testables.renderPlanningWarning ??
    __testables.formatActivePlanningMessage ??
    __testables.getPlanningBanner;

  assert.ok(formatBanner, "Expected a planning-banner formatting function to be exported from __testables");

  const planningState = makePlanningState({ active: false });
  const banner: string = typeof formatBanner === "function" ? formatBanner(planningState) : String(formatBanner);

  // When inactive, the banner should be empty/falsy or contain no color codes
  const isEmpty = !banner || banner.trim() === "";
  const hasNoColor = !containsHighVisibilityColor(banner);

  assert.ok(
    isEmpty || hasNoColor,
    `Expected no visible banner when planning is inactive, but got:\n${JSON.stringify(banner)}`,
  );
});

test("applyPlanningState round-trips correctly and getPlanningState returns stored state", async () => {
  const ctx = makeCtx();
  assert.equal(__testables.getPlanningState(ctx), undefined);

  const planningState = makePlanningState();
  await __testables.applyPlanningState(ctx, planningState);
  assert.deepEqual(__testables.getPlanningState(ctx), planningState);
});

test("clearPlanningState removes the stored planning state", async () => {
  const ctx = makeCtx();
  const planningState = makePlanningState();
  await __testables.applyPlanningState(ctx, planningState);
  assert.deepEqual(__testables.getPlanningState(ctx), planningState);

  __testables.clearPlanningState(ctx);
  assert.equal(__testables.getPlanningState(ctx), undefined);
});

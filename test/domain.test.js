import assert from "node:assert/strict";
import { test } from "node:test";
import { compareTimestamp, titleOf, truncateSessionStart } from "../server/domain.js";

test("session timestamps sort Date objects and ISO strings chronologically", () => {
  const newest = new Date("2026-08-11T05:28:36.182Z");
  const older = "2026-08-10T05:28:36.182Z";
  assert.equal(compareTimestamp(newest, older) > 0, true);
  assert.equal(compareTimestamp(older, newest) < 0, true);
});

test("unnamed sessions use a compact start-of-session fallback", () => {
  assert.equal(truncateSessionStart("  A\n\n  long session prompt with details  ", 12), "A long sessi");
  assert.equal(titleOf({ name: "Named session", firstMessage: "ignored" }), "Named session");
  assert.equal(titleOf({ name: null, firstMessage: "first prompt" }), "first prompt");
  assert.equal(titleOf({ name: null, firstMessage: "" }), "New session");
  assert.equal(titleOf({ name: null, firstMessage: "Fix **the** `parser`" }), "Fix the parser");
});

test("Pi's no-messages sentinel is an empty title, so the first prompt shows instead", () => {
  assert.equal(titleOf({ name: null, firstMessage: "(no messages)" }), "New session");
  assert.equal(titleOf({ name: "(no messages)", firstMessage: "Ship the chat" }), "Ship the chat");
});

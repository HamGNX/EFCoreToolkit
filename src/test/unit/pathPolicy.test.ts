import assert from "node:assert/strict";
import test from "node:test";
import { isPathInside } from "../../services/pathPolicy";

test("accepts workspace and descendants", () => {
  assert.equal(isPathInside("/repo", "/repo"), true);
  assert.equal(isPathInside("/repo", "/repo/Models/Entities"), true);
});

test("rejects sibling prefixes and traversal", () => {
  assert.equal(isPathInside("/repo", "/repo-other"), false);
  assert.equal(isPathInside("/repo", "/repo/../outside"), false);
});

import test from "node:test";
import assert from "node:assert/strict";
test("issue 45 verify: deliberately red", () => { assert.equal(1, 2); });

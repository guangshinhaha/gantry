import { test } from "node:test";
import assert from "node:assert/strict";
import { parseGlobs, match } from "../risky-paths.mjs";

const globs = parseGlobs(`# comment
**/auth/**
**/migrations/**

prisma/schema.prisma
**/*rls*
**/payments/**
**/api-keys/**
`);
const hit = (f) => match(globs, [f]).length === 1;

test("parseGlobs skips comments and blanks", () => assert.equal(globs.length, 6));
test("matches nested and top-level dirs", () => {
  assert.ok(hit("src/auth/login.ts"));
  assert.ok(hit("auth/login.ts"));
  assert.ok(hit("apps/web/src/payments/a/b.ts"));
  assert.ok(hit("db/migrations/001.sql"));
  assert.ok(hit("src/api-keys/x.ts"));
});
test("exact path and name globs", () => {
  assert.ok(hit("prisma/schema.prisma"));
  assert.ok(!hit("other/prisma/schema.prisma"));
  assert.ok(hit("src/db/rls-policies.sql"));
  assert.ok(hit("rls.sql"));
});
test("non-matches", () => {
  assert.ok(!hit("src/author/x.ts"));
  assert.ok(!hit("src/oauth.ts"));
  assert.ok(!hit("README.md"));
  assert.ok(!hit("src/migrations.ts"));
});
test("reports every matching glob", () => {
  const r = match(globs, ["src/auth/rls.ts"]);
  assert.deepEqual(r[0].globs, ["**/auth/**", "**/*rls*"]);
});
test("regex metachars are escaped", () => assert.ok(!match(["a.b"], ["axb"]).length));

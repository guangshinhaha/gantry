import { test } from 'node:test';
import assert from 'node:assert';
test('issue 45 proof: deliberately fails', () => { assert.strictEqual(1, 2); });

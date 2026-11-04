// Mutation testing (gantry). CI mutates only the files a PR changes.
// Locally: npx stryker run --mutate src/lib/foo.ts
// @ts-check
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: "__RUNNER__",
  __RUNNER_OPTIONS__
  checkers: ["typescript"],
  mutate: [
    "src/**/*.{ts,tsx,js,jsx}",
    "!src/**/*.{test,spec,stories}.*",
    "!src/**/*.d.ts",
    "!src/**/{test,tests,__tests__,__mocks__}/**",
  ],
  ignoreStatic: true, // static mutants re-run every test: slow, rarely useful
  incremental: true,
  thresholds: { high: 80, low: 60, break: null }, // set break (e.g. 60) to fail CI
  reporters: ["html", "json", "clear-text", "progress"],
};

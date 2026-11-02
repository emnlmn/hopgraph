import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Two suites: `unit` (the tests next to the code, the examples, and the bugs the property tests
// found, kept as skipped tests in test/found until fixed and then in test/regressions) and `props`
// (the property tests in test/props, run from a printed seed). `npm test` runs the first,
// `npm run test:props` the second.
export default defineConfig({
  resolve: {
    // the examples and test/ import the package by name, as a consumer would; they run on the source
    alias: { hopgraph: fileURLToPath(new URL("./src/index.ts", import.meta.url)) },
  },
  test: {
    restoreMocks: true,
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: [
            "src/**/*.test.ts",
            "examples/**/*.test.ts",
            "test/found/**/*.test.ts",
            "test/regressions/**/*.test.ts",
          ],
        },
      },
      {
        extends: true,
        test: {
          name: "props",
          include: ["test/props/**/*.test.ts"],
          globalSetup: ["test/props/setup.ts"],
        },
      },
    ],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/__tests__/**"],
      // the level the unit tests reached when the threshold was set: it may rise, never fall
      thresholds: { statements: 98.5, branches: 95, functions: 99, lines: 99.5 },
    },
  },
});

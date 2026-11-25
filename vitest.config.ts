import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/*/test/**/*.test.ts",
      "apps/backend/test/**/*.test.ts",
      "apps/phone/test/**/*.test.ts",
      "scripts/test/**/*.test.ts",
      // the React dashboard: jsdom per file (// @vitest-environment jsdom)
      "apps/dashboard/test/**/*.test.{ts,tsx}",
    ],
    environment: "node",
    // The end-to-end test boots the server and replays all scenarios; 5s is too tight on a busy machine.
    testTimeout: 30_000,
  },
});

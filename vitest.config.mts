import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Resolve the app's `@/*` path alias (tsconfig) for tests.
const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: { "@": root },
  },
  test: {
    exclude: ["node_modules/**", "src-tauri/**", "crates/**", "out/**", ".next/**"],
  },
});

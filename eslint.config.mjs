import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "src-tauri/**",
    "crates/**",
  ]),
  // Error-handling guardrails: warn on silently swallowed errors and alert().
  {
    files: ["app/**/*.{ts,tsx}", "components/**/*.{ts,tsx}", "lib/**/*.{ts,tsx}", "contexts/**/*.{ts,tsx}", "store/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": [
        "warn",
        {
          selector: "CatchClause > BlockStatement[body.length=0]",
          message: "Don't swallow errors silently — log via @/lib/log (logWarn/logDebug) or surface via @/lib/toast (surfaceError).",
        },
        {
          selector: "CallExpression[callee.name='alert']",
          message: "Use toastError/toastInfo from @/lib/toast instead of alert().",
        },
      ],
    },
  },
  {
    // The error-handling foundation has intentional "never throw" guards.
    files: ["lib/error/**/*.ts", "lib/log.ts", "lib/toast.ts"],
    rules: { "no-restricted-syntax": "off" },
  },
]);

export default eslintConfig;

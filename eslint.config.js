// @ts-check
import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // .agents/ is vendored third-party code (obra/superpowers, DietrichGebert/ponytail) — not ours to lint.
  { ignores: ["**/dist/**", "**/node_modules/**", "**/artifacts/**", ".agents/**"] },
  js.configs.recommended,
  tseslint.configs.recommended,
  prettier,
  {
    files: ["**/*.js", "**/*.mjs"],
    languageOptions: { globals: { ...globals.node } },
  },
);

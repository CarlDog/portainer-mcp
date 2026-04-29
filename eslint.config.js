import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettierConfig from "eslint-config-prettier";

export default [
  {
    ignores: ["dist/**", ".serena/**", "node_modules/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettierConfig,
];

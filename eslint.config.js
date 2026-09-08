import js from "@eslint/js";
import globals from "globals";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import importX from "eslint-plugin-import-x";

export default [
  { ignores: ["dist", "dist-react"] },
  {
    files: ["**/*.{js,jsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      // Electron codebase: renderer files use browser globals, the API/Electron
      // main and tests use Node globals — allow both (flat config replaces the
      // old `env: { node: true }` key, which is unsupported here).
      globals: { ...globals.browser, ...globals.node },
      parserOptions: {
        ecmaVersion: "latest",
        ecmaFeatures: { jsx: true },
        sourceType: "module",
      },
    },
    settings: {
      react: { version: "18.3" },
      // Resolve bare npm imports via Node's algorithm so `import-x/no-unresolved`
      // only flags genuinely broken/miscased *relative* imports, not packages.
      // The renderer (src/ui) uses extensionless imports resolved by Vite, so the
      // resolver must try these extensions to match real build behavior.
      "import-x/resolver-next": [
        importX.createNodeResolver({
          extensions: [".js", ".jsx", ".json", ".mjs", ".cjs"],
        }),
      ],
    },
    plugins: {
      react,
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
      "import-x": importX,
    },
    rules: {
      ...js.configs.recommended.rules,
      ...react.configs.recommended.rules,
      ...react.configs["jsx-runtime"].rules,
      ...reactHooks.configs.recommended.rules,
      // Case-sensitive import resolution. Windows/macOS dev filesystems are
      // case-insensitive and silently tolerate `./Config.js` when the file is
      // `config.js`, but the packaged app.asar is case-sensitive and crashes
      // with ERR_MODULE_NOT_FOUND. This makes the mismatch a lint error in-editor.
      "import-x/no-unresolved": ["error", { caseSensitive: true }],
      "react/jsx-no-target-blank": "off",
      // A deliberately empty catch is a real pattern here and reads as one: setting
      // `audio.currentTime` throws on media that has not loaded, an optional sidecar
      // may simply not exist, a malformed inline snapshot is skipped on purpose. The
      // binding-less `catch {}` form already says "the error is the expected case",
      // so allow it — and keep `no-empty` on for every other block, where an empty
      // body really is a mistake. An empty catch that is NOT intentional should be
      // written with a body, not left bare.
      "no-empty": ["error", { allowEmptyCatch: true }],
      // With the above, `catch (e) {}` has no reason to keep an unused binding —
      // dropping it is what marks the block as intentional rather than unfinished.
      "no-unused-vars": ["error", { caughtErrors: "all" }],
      // This codebase does not use prop-types (runtime validation) anywhere;
      // component contracts are documented in INTERFACE.md instead. Leaving the
      // recommended rule on would flag every component in the app.
      "react/prop-types": "off",
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],
    },
  },
  {
    // Comments are JSDoc above the thing they describe, and rationale lives in the
    // co-located .md rather than in the source. These two rules catch trailing comments
    // only; "no comment inside a function body" has no core rule and stays review
    // discipline. Scoped to the trees that have been through the normalization pass --
    // add src/ui once it has, and decide separately about tests/ and scripts/.
    files: [
      "src/api/**/*.js",
      "src/electron/**/*.js",
      "src/server/**/*.js",
      "src/mcp/**/*.js",
      "src/shared/**/*.js",
    ],
    rules: {
      "no-inline-comments": "error",
      "line-comment-position": ["error", { position: "above" }],
    },
  },
];

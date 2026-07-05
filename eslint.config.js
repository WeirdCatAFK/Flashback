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
];

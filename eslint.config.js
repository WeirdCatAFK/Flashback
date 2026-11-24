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
      globals: { ...globals.browser, ...globals.node },
      parserOptions: {
        ecmaVersion: "latest",
        ecmaFeatures: { jsx: true },
        sourceType: "module",
      },
    },
    settings: {
      react: { version: "18.3" },
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
      "import-x/no-unresolved": ["error", { caseSensitive: true }],
      "react/jsx-no-target-blank": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-unused-vars": ["error", { caughtErrors: "all" }],
      "react/prop-types": "off",
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],
    },
  },
  {
    files: [
      "src/api/**/*.js",
      "src/electron/**/*.js",
      "src/server/**/*.js",
      "src/mcp/**/*.js",
      "src/shared/**/*.js",
      "src/ui/**/*.{js,jsx}",
    ],
    rules: {
      "no-inline-comments": "error",
      "line-comment-position": ["error", { position: "above" }],
    },
  },
  {
    files: ["src/api/**/*.js"],
    rules: {
      "import-x/no-restricted-paths": ["error", {
        zones: [
          {
            target: "./src/api/access/primitives",
            from: ["./src/api/access/resources", "./src/api/access/modules"],
            message: "primitives/ is the bottom tier.",
          },
          {
            target: "./src/api/access/resources",
            from: "./src/api/access/modules",
            message: "resources/ never imports modules/.",
          },
          {
            target: "./src/api/routes",
            from: "./src/api/access/resources",
            message: "Routes call modules/, never resources/.",
          },
        ],
      }],
    },
  },
  {
    files: ["src/api/access/modules/**/*.js", "src/api/routes/**/*.js"],
    rules: {
      "no-restricted-syntax": ["error", {
        selector: "CallExpression[callee.object.name='db'][callee.property.name=/^(prepare|exec)$/]",
        message: "Only resources/db/ queries the vault database.",
      }],
    },
  },
];

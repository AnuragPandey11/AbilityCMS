module.exports = {
  root: true,
  env: { browser: true, es2022: true },
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
    "plugin:react-hooks/recommended",
  ],
  parser: "@typescript-eslint/parser",
  parserOptions: { ecmaVersion: "latest", sourceType: "module" },
  plugins: ["@typescript-eslint", "react-hooks"],
  ignorePatterns: ["dist", "node_modules", ".eslintrc.cjs"],
  rules: {
    "@typescript-eslint/no-non-null-assertion": "off",
    "@typescript-eslint/no-explicit-any": "error",
    "no-restricted-syntax": [
      "error",
      {
        // Guardrail 5: gate on permissions, never on role. A custom role is data
        // rather than a schema change (tender §29), so `role === "admin"` breaks
        // the moment a Client defines their own.
        selector:
          "BinaryExpression[operator=/^===?$/] > MemberExpression[property.name='role']",
        message:
          "Never gate on `role` — use usePermission(). Permissions are composable rows; a custom role is data.",
      },
    ],
  },
};

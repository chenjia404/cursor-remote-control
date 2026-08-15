import js from "@eslint/js";
import globals from "globals";

/** 前端脚本不经过 tsc；语法错误会直接导致「应用脚本加载失败」。 */
export default [
  {
    ignores: ["dist/**", "data/**", "src/public/vendor/**", "node_modules/**"],
  },
  {
    files: ["src/public/*.js"],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.browser,
        ...globals.serviceworker,
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      // 页面脚本里未使用的辅助函数很常见，不因此挡住语法检查
      "no-unused-vars": "off",
    },
  },
];

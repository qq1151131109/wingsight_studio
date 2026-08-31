import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // 克隆的对标参考项目（第三方代码，不参与 lint/tsc）
    "references/**",
    // langflow 引擎源码（subtree 并入的自有 fork，不参与前端 lint/tsc）
    "langflow/**",
  ]),
]);

export default eslintConfig;

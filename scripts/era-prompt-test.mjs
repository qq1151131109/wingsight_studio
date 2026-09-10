/**
 * 「调研发起前问年代」回归（纯函数层，无浏览器 / 无 LLM）。
 *
 * 背景：meta.era 是考据跨项目复用的作用域键（服务端按 (era, 资产名) 命中
 * 同题材项目的历史条目），era 为空则一律不复用 → 每次调研都重搜一遍。生产
 * 23 个项目实测无一设过：`set_project_era` 是 agent 工具，而调研是用户点
 * 按钮发起、不经过 agent。故在花钱的入口问一次（可跳过），本脚本锁住判据。
 *
 * 运行：pnpm dlx tsx scripts/era-prompt-test.mjs
 */
import { saneEra, shouldPromptEra } from "../lib/canvas/store.ts";

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? " — " + detail : ""}`);
};

const NONE = new Set();
const SKIPPED = new Set(["p1"]);

check("真实题材 + 未设 era → 问", shouldPromptEra("", "real", "p1", NONE));
check("era 只有空白 → 问（trim 语义）", shouldPromptEra("   ", "real", "p1", NONE));
check("已设 era → 不再问", !shouldPromptEra("北魏·平城时期", "real", "p1", NONE));
check("虚构题材（动画/架空）→ 不问", !shouldPromptEra("", "fiction", "p1", NONE));
check("本会话跳过过 → 不再问", !shouldPromptEra("", "real", "p1", SKIPPED));
check("跳过的是别的项目 → 本项目照问", shouldPromptEra("", "real", "p2", SKIPPED));
check("无项目上下文 → 不问", !shouldPromptEra("", "real", "", NONE));
check(
  "saneEra 截断到 40 字并 trim",
  saneEra(`  ${"x".repeat(60)}  `) === "x".repeat(40),
);
check("saneEra 非字符串回落空串", saneEra(null) === "" && saneEra(123) === "");

console.log(`\n${pass}/${pass + fail} 通过`);
process.exit(fail ? 1 : 0);

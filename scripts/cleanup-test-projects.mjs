/**
 * 清理 E2E 测试残留项目（2026-09-11）。
 *
 * 背景：各测试脚本都写了「结束自删」，但**崩在半路 / Ctrl-C / 断言失败**时
 * teardown 根本不执行；跑了几十轮的代价是首页项目列表被 `e2e-*` 占满
 * （实测 23 个项目里 20 个是垃圾），也让 checkpoints 库继续膨胀。
 * 与「谁泄漏谁修」相反：这里按**名字前缀**统一回收，任何一次残留都能一键清掉。
 *
 *   node scripts/cleanup-test-projects.mjs --dry-run   # 只列不删
 *   node scripts/cleanup-test-projects.mjs             # 真删（走服务端 delete_project）
 *   node scripts/cleanup-test-projects.mjs foo- bar-   # 追加自定义前缀
 *
 * 前置：agent(8123) + 前端(8008) 在跑。删除经 `DELETE /projects/{pid}` 走
 * 服务端真实级联（projects / canvases / chat_threads / chat_messages / assets），
 * 不直接在 SQLite 上写 SQL——免得遗漏某张表的引用。
 */
import { readFileSync } from "node:fs";

const BASE = "http://127.0.0.1:8008";
const API = `${BASE}/agent-service`;

/** 测试脚本建项目的既有命名（grep `e2e-` / `verify-` 可复核） */
const PREFIXES = ["e2e-", "verify-", ...process.argv.slice(2).filter((a) => !a.startsWith("--"))];
const DRY_RUN = process.argv.includes("--dry-run");

function envLocal(key) {
  for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
    if (line.startsWith(`${key}=`)) return line.slice(key.length + 1).trim();
  }
  return "";
}

let TOKEN = "";
{
  const r = await fetch(`${BASE}/api/v1/auth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      username: envLocal("AUTH_USERNAME") || "admin",
      password: envLocal("AUTH_PASSWORD"),
    }),
  });
  if (r.ok) TOKEN = (await r.json()).access_token ?? "";
}
const auth = TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {};

const listRes = await fetch(`${API}/projects`, { headers: auth });
if (!listRes.ok) {
  console.error(`✗ 列举项目失败：HTTP ${listRes.status}（agent/前端在跑吗？）`);
  process.exit(1);
}
const projects = await listRes.json();
const isTest = (name) => PREFIXES.some((p) => String(name ?? "").startsWith(p));
const doomed = projects.filter((p) => isTest(p.name));
const kept = projects.filter((p) => !isTest(p.name));

console.log(`项目共 ${projects.length} 个；命中前缀 ${PREFIXES.join(" / ")} 的 ${doomed.length} 个`);
for (const p of doomed) console.log(`  - ${p.name}  (${p.id})`);
console.log(`保留 ${kept.length} 个：${kept.map((p) => p.name).join(" / ") || "（无）"}`);

if (DRY_RUN) {
  console.log("\n--dry-run：未删除任何项目。");
  process.exit(0);
}
if (doomed.length === 0) {
  console.log("\n没有需要清理的项目。");
  process.exit(0);
}

let ok = 0;
const failed = [];
for (const p of doomed) {
  const r = await fetch(`${API}/projects/${p.id}`, { method: "DELETE", headers: auth });
  if (r.ok) {
    ok += 1;
    continue;
  }
  failed.push(`${p.name}：HTTP ${r.status}`);
}
console.log(`\n✓ 已删除 ${ok}/${doomed.length} 个测试项目`);
if (failed.length > 0) {
  console.error("✗ 删除失败：\n  " + failed.join("\n  "));
  process.exit(1);
}

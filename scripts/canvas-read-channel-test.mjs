/**
 * 回归：画布读通道 v2 + ops 干跑/执行（纯函数层，不依赖浏览器与 LLM）。
 *  - summarizeCanvas 索引化：头部计数/警告/revision 恒在、锚点（剧本/分镜表/
 *    调研）置顶永不丢、连线列清单上限、超预算明示 canvas_query 出口
 *  - validateOps 顺序敏感干跑：占位符同批建连合法、猜 id/重复连线/自连/
 *    删后再引用报错、rows 资产名无同名卡告警
 *  - applyOps 同批「建卡即连线」（曾因循环外 state 快照误报不存在——
 *    2026-09-03 27 卡事故连线全灭的另一半根因）
 * 运行：pnpm dlx tsx scripts/canvas-read-channel-test.mjs（tsx 解析 TS 与
 * extensionless import；node 原生 strip-types 不行）
 */
import { validateOps, applyOps } from "/home/shenglin/Desktop/wingsight-studio/lib/canvas/ops.ts";
import { summarizeCanvas } from "/home/shenglin/Desktop/wingsight-studio/lib/canvas/store.ts";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { ok ? pass++ : fail++; console.log(`${ok ? "✓" : "✗"} ${name}${detail ? " — " + detail : ""}`); };

// —— 摘要：纯函数走传参，96 节点事故现场量级 ——
const nodes = [];
for (let i = 0; i < 88; i++)
  nodes.push({ id: `n_asset_${i}`, type: "character", position: { x: i * 40, y: 0 }, data: { nodeType: "character", title: i === 0 ? "郑成功" : `资产${i}`, body: "设定文本".repeat(10) } });
nodes.push({ id: "n_script_1", type: "script", position: { x: 0, y: 1 }, data: { nodeType: "script", title: "", body: "剧本正文" } });
nodes.push({ id: "n_sl_92", type: "shotlist", position: { x: 0, y: 2 }, data: { nodeType: "shotlist", title: "", rows: Array.from({ length: 42 }, (_, i) => ({ rid: `r${i}`, action: `镜头${i}` })) } });
nodes.push({ id: "n_img_err", type: "image", position: { x: 0, y: 3 }, data: { nodeType: "image", title: "失败图", status: "error" } });
nodes.push({ id: "n_img_ok", type: "image", position: { x: 0, y: 4 }, data: { nodeType: "image", title: "定妆照", imageUrl: "/agent-service/assets/ab12.webp" } });
for (let i = 0; i < 4; i++) nodes.push({ id: `n_grp_${i}`, type: "group", position: { x: 0, y: 5 }, data: { nodeType: "group", title: `组${i}` } });
const edges = Array.from({ length: 89 }, (_, i) => ({ id: `e${i}`, source: `n_asset_${i % 88}`, target: "n_sl_92" }));

const s = summarizeCanvas(nodes, edges, [], 2000, 42);
check("分镜表（数组末位）在摘要中可见", s.includes("n_sl_92"), `含 42 行标记=${s.includes("（42 行）")}`);
check("剧本锚点在摘要中", s.includes("n_script_1"));
check("版本号在头部", s.includes("版本 r42"));
check("错误警告在头部", s.includes("生成失败 1"));
check("摘要守预算", s.length <= 2000, `len=${s.length}`);
check("超预算明示查询出口", s.includes("canvas_query"));
check("连线上限截断明示", s.includes("条连线略"));

// —— validateOps：store 依赖用例经 applyOps 种子（同一模块图）——
const seeded = applyOps([
  { op: "add_node", nodeType: "note", id: "n_a", title: "A" },
  { op: "add_node", nodeType: "note", id: "n_b", title: "B" },
  { op: "connect_nodes", fromId: "n_a", toId: "n_b" },
  { op: "add_node", nodeType: "character", id: "n_zgc", title: "郑成功" },
]);
check("种子 4 项全部应用", seeded.applied === 4 && seeded.errors.length === 0);

const v1 = validateOps([
  { op: "add_node", nodeType: "storyboard", id: "SB_1", title: "镜1" },
  { op: "add_node", nodeType: "storyboard", id: "SB_2", title: "镜2" },
  { op: "connect_nodes", fromId: "SB_1", toId: "SB_2" },
]);
check("占位符同批建连合法", v1.ok, JSON.stringify(v1.issues));

const v2 = validateOps([{ op: "connect_nodes", fromId: "SB_99", toId: "n_a" }]);
check("引用未建占位符报错", !v2.ok && v2.issues.some(i => i.message.includes("SB_99")));

const v3 = validateOps([
  { op: "add_node", nodeType: "note", id: "TMP_1" },
  { op: "delete_nodes", ids: ["TMP_1"] },
  { op: "connect_nodes", fromId: "TMP_1", toId: "n_a" },
]);
check("顺序敏感：删后再引用报错", !v3.ok && v3.issues.some(i => i.message.includes("TMP_1")));

const v4 = validateOps([{ op: "connect_nodes", fromId: "n_a", toId: "n_b" }]);
check("已存在连线查重报错", !v4.ok && v4.issues.some(i => i.message.includes("已存在")), v4.issues.map(i=>i.message).join("|"));

const v5 = validateOps([{ op: "update_node", id: "n_a", rows: [{ rid: "r1", assets: ["郑成功", "不存在的人"] }] }]);
check("rows 资产名无同名卡告警", v5.ok && v5.issues.some(i => i.severity === "warning" && i.message.includes("不存在的人")), JSON.stringify(v5.issues));

const v6 = validateOps([{ op: "connect_nodes", fromId: "n_a", toId: "n_a" }]);
check("自连报错", !v6.ok);

// 截断守卫：部分解析残骸（前几行完整 + 尾部空对象）整批拒绝，干跑同款报错
const trunc = [
  { rid: "r1", action: "雨夜面馆全景", shotSize: "大全景" },
  { rid: "r2", action: "老周擦杯", shotSize: "中景" },
  {},
];
const a1 = applyOps([{ op: "update_node", id: "n_a", rows: trunc }]);
check("应用侧拒绝截断行（整 op 未落）", a1.applied === 0 && a1.errors.some(e => e.includes("内容全空")), a1.errors.join("|"));
const a2 = validateOps([{ op: "update_node", id: "n_a", rows: trunc }]);
check("干跑侧发现截断行", !a2.ok && a2.issues.some(i => i.message.includes("内容全空")));

console.log(`\n${fail === 0 ? `全部通过（${pass} 项）` : `${fail} 项失败`}`);
process.exit(fail === 0 ? 0 : 1);

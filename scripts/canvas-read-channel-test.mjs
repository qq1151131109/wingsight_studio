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
import { validateOps, applyOps, useCanvasStore } from "/home/shenglin/Desktop/wingsight-studio/lib/canvas/ops.ts";
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

// —— 批量建卡自动分组排版（agent 建资产带：白骨精项目 25 卡横排 8700px 事故）——
// 不带 position 的 add_node 应按类型收组框（角色/场景/道具/服饰），组内 √n 网格，
// 在现有内容下方开带；单项不套框；带 position 的卡尊重坐标不参与
const stBefore = useCanvasStore.getState();
const maxYBefore = Math.max(...stBefore.nodes.map(n => n.position.y));
const g1 = applyOps([
  { op: "add_node", nodeType: "character", id: "C_1", title: "白骨夫人" },
  { op: "add_node", nodeType: "character", id: "C_2", title: "孙悟空" },
  { op: "add_node", nodeType: "character", id: "C_3", title: "唐僧" },
  { op: "add_node", nodeType: "scene", id: "S_1", title: "白虎岭" },
  { op: "add_node", nodeType: "scene", id: "S_2", title: "取经路" },
  { op: "add_node", nodeType: "prop", id: "P_1", title: "金箍棒" },
  { op: "add_node", nodeType: "note", id: "N_9", title: "备忘" },
]);
check("批量 7 卡全部应用无错", g1.applied === 7 && g1.errors.length === 0, g1.errors.join("|"));
const stAfter = useCanvasStore.getState();
const node = (id) => useCanvasStore.getState().nodes.find(n => n.id === id);
const groups = useCanvasStore.getState().nodes.filter(n => n.data.nodeType === "group" && ["角色", "场景"].includes(n.data.title));
check("角色/场景各收一个组框（道具/备注单项不套框）", groups.length === 2,
  stAfter.nodes.filter(n => n.data.nodeType === "group").map(n => n.data.title).join(","));
const charGroup = groups.find(g => g.data.title === "角色");
const sceneGroup = groups.find(g => g.data.title === "场景");
check("三张角色卡同入「角色」组框", ["C_1", "C_2", "C_3"].every(id => node(id)?.parentId === charGroup?.id));
check("两张场景卡同入「场景」组框", ["S_1", "S_2"].every(id => node(id)?.parentId === sceneGroup?.id));
check("单项道具/备注不进组框", node("P_1")?.parentId === undefined && node("N_9")?.parentId === undefined);
const abs = (id) => {
  const n = node(id);
  if (!n) return { x: NaN, y: NaN };
  if (!n.parentId) return n.position;
  const p = node(n.parentId);
  return { x: p.position.x + n.position.x, y: p.position.y + n.position.y };
};
const charYs = new Set(["C_1", "C_2", "C_3"].map(id => abs(id).y));
check("角色组内网格换行（不再一条横排）", charYs.size >= 2, `y 集合=${[...charYs].join(",")}`);
check("资产带开在现有内容下方", abs("C_1").y >= maxYBefore, `首卡 y=${abs("C_1").y} 原 maxY=${maxYBefore}`);
check("组框 id 进 createdIds（agent 侧选中整框）", g1.createdIds.length === 9, `created=${g1.createdIds.length}`);
// 带 position 的卡不参与自动分组：精确摆位尊重原坐标、不套框
const g2 = applyOps([{ op: "add_node", nodeType: "scene", id: "S_9", title: "天庭", position: { x: 5000, y: -800 } }]);
const s9 = node("S_9");
check("显式 position 按坐标放且不进组框", g2.errors.length === 0 && s9?.position.x === 5000 && s9?.parentId === undefined,
  `pos=${JSON.stringify(s9?.position)} parent=${s9?.parentId}`);

// —— 文本卡建卡尺寸分档（2026-09-09 090803 事故：1302 字策划挤在 280×170 便签框）——
// note 足迹是便签时代的尺寸，现在 note 承载策划案/上传文档全文 → 按正文长度分档；
// 布局格子必须与落卡尺寸同源，否则长文 note 会互相压
const longBody = "字".repeat(500);
const hugeBody = "字".repeat(2500);
const d1 = applyOps([
  { op: "add_node", nodeType: "note", id: "N_short", title: "短便签", body: "三行以内" },
  { op: "add_node", nodeType: "note", id: "N_long", title: "策划稿", body: longBody },
  { op: "add_node", nodeType: "note", id: "N_huge", title: "长资料", body: hugeBody },
]);
check("三张 note 全部应用", d1.applied === 3 && d1.errors.length === 0, d1.errors.join("|"));
const sizeOf = (id) => {
  const n = node(id);
  return { w: Number(n?.style?.width), h: Number(n?.style?.height) };
};
check("短便签保持便签尺寸 280×170", sizeOf("N_short").w === 280 && sizeOf("N_short").h === 170, JSON.stringify(sizeOf("N_short")));
check("长文 note 落文档尺寸 480×360", sizeOf("N_long").w === 480 && sizeOf("N_long").h === 360, JSON.stringify(sizeOf("N_long")));
check("超长 note 落 560×480", sizeOf("N_huge").w === 560 && sizeOf("N_huge").h === 480, JSON.stringify(sizeOf("N_huge")));
// 批量布局按分档尺寸排格：三张长文 note 的 y 或 x 间距不得小于卡高/卡宽（不叠卡）
const ys = ["N_long", "N_huge"].map((id) => node(id).position.y);
const xs = ["N_long", "N_huge"].map((id) => node(id).position.x);
check("分档 note 的布局格子跟着尺寸走（不叠卡）",
  new Set(ys).size === 2 || new Set(xs).size === 2, `x=${xs.join(",")} y=${ys.join(",")}`);
// style 三来源合并：批量建卡（stagger>0）的卡不得丢掉分档尺寸（分开 spread 会覆盖）
const longNode = node("N_long");
check("批量建卡（stagger>0）分档尺寸与级联变量共存",
  sizeOf("N_long").w === 480 && typeof longNode?.style?.["--ws-stagger"] === "string",
  JSON.stringify(longNode?.style));

console.log(`\n${fail === 0 ? `全部通过（${pass} 项）` : `${fail} 项失败`}`);
process.exit(fail === 0 ? 0 : 1);

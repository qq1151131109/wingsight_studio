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
import { validateOps, applyOps, useCanvasStore } from "../lib/canvas/ops.ts";
import { summarizeCanvas } from "../lib/canvas/store.ts";

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

// —— 分镜行「场次」透传（相邻镜头连贯参考的配对依据；缺了就只能按行号猜）——
const a7 = applyOps([{
  op: "update_node", id: "n_a",
  rows: [
    { rid: "r1", scene: "御书房·夜", action: "展开密信" },
    { rid: "r2", scene: "御书房·夜", action: "火漆印特写" },
    { rid: "r3", action: "无场次行" },
    { rid: "r4", scene: "街".repeat(40), action: "超长场次名" },
  ],
}]);
const rowsA = useCanvasStore.getState().nodes.find((n) => n.id === "n_a")?.data?.rows ?? [];
check("update_node rows 场次透传", a7.applied === 1 && rowsA[0]?.scene === "御书房·夜" && rowsA[1]?.scene === "御书房·夜",
  JSON.stringify(rowsA.map(r => [r.rid, r.scene])));
check("缺场次的行不补默认值（留空=不配相邻参考）", rowsA[2]?.scene === undefined, `r3=${JSON.stringify(rowsA[2])}`);
check("场次名截断 30 字（防工具参数超长）", rowsA[3]?.scene?.length === 30, `len=${rowsA[3]?.scene?.length}`);

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
// —— 资产带内组框顺序：角色→服饰→场景→道具（2026-09-11 用户口径「服饰应该和
// 角色挨着」）。服饰有主（造型计划把服饰绑到角色、造型图参考图2=服饰结构图），
// 与场景/道具（环境与物件家族）不是一类；此前服饰排带尾，角色组右缘到服饰组
// 隔了 2136px（091001 实测：角色 x=-36 / 场景 1028 / 道具 2092 / 服饰 3156）——
// 找某角色的衣服要横穿两组框。拆解链（nodes.tsx KIND_ORDER）同款顺序
const gOrder = applyOps([
  { op: "add_node", nodeType: "character", id: "K_C1", title: "角色甲" },
  { op: "add_node", nodeType: "character", id: "K_C2", title: "角色乙" },
  { op: "add_node", nodeType: "costume", id: "K_K1", title: "朝服" },
  { op: "add_node", nodeType: "costume", id: "K_K2", title: "常服" },
  { op: "add_node", nodeType: "scene", id: "K_S1", title: "大殿" },
  { op: "add_node", nodeType: "scene", id: "K_S2", title: "街市" },
  { op: "add_node", nodeType: "prop", id: "K_P1", title: "环首刀" },
  { op: "add_node", nodeType: "prop", id: "K_P2", title: "灯笼" },
]);
const gx = (label) => useCanvasStore.getState().nodes.find((n) => n.data.nodeType === "group" && n.data.title === label)?.position.x;
const gw = (label) => {
  const g = useCanvasStore.getState().nodes.find((n) => n.data.nodeType === "group" && n.data.title === label);
  return (g?.style?.width ?? 0) + (g?.position.x ?? 0);
};
check("四类资产各成一框（角色/服饰/场景/道具）",
  gOrder.errors.length === 0 && ["角色", "服饰", "场景", "道具"].every((l) => Number.isFinite(gx(l))),
  `x=${["角色", "服饰", "场景", "道具"].map((l) => gx(l)).join(",")}`);
check("服饰框紧挨角色框右缘（不与场景/道具夹隔）",
  gx("服饰") < gx("场景") && gx("服饰") < gx("道具") && gx("服饰") >= gw("角色"),
  `角色右缘=${gw("角色")} 服饰 x=${gx("服饰")} 场景 x=${gx("场景")} 道具 x=${gx("道具")}`);
check("场景/道具退到外侧（原角色/场景/道具/服饰顺序已改）",
  gx("角色") < gx("服饰") && gx("服饰") < gx("场景") && gx("场景") < gx("道具"));
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
check("长文 note 按正文实算给高（500 字 → 480×367）", sizeOf("N_long").w === 480 && sizeOf("N_long").h === 367, JSON.stringify(sizeOf("N_long")));
check("超长 note 高度钳到上限 560×760（超出滚动）", sizeOf("N_huge").w === 560 && sizeOf("N_huge").h === 760, JSON.stringify(sizeOf("N_huge")));
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
// 候选阅读卡（2026-09-09 二轮终态：高度按正文实算——候选池 100-300 字的
// 「读」卡不再挤便签框也不再固定档截半，全文可见）
const d1b = applyOps([
  { op: "add_node", nodeType: "note", id: "N_read", title: "候选·沈太福", body: "字".repeat(210) },
]);
check("候选阅读卡宽度按量选档 440、高度实算 211",
  d1b.errors.length === 0 && sizeOf("N_read").w === 440 && sizeOf("N_read").h === 211,
  JSON.stringify(sizeOf("N_read")));
const d1c = applyOps([
  { op: "add_node", nodeType: "note", id: "N_links", title: "带来源", body: "字".repeat(210),
    links: [{ title: "a", url: "https://a.example" }, { title: "b", url: "https://b.example" }] },
]);
check("links 来源行计入卡高（2 条 +38）",
  d1c.errors.length === 0 && sizeOf("N_links").h === sizeOf("N_read").h + 38,
  JSON.stringify(sizeOf("N_links")));

// —— links 透传（候选落卡 P1：可点来源行）——
import { sanitizeCanvas } from "../lib/canvas/sanitize.ts";
const d2 = applyOps([
  {
    op: "add_node", nodeType: "note", id: "N_cand", title: "候选·民族资产解冻",
    body: "跨 40 年的金光党骗术…材料底数：厚",
    links: [
      { title: "公安部公布 78 个项目", url: "http://www.news.cn/legal/2024/117ca.html" },
      { title: "维基百科词条", url: "https://zh.wikipedia.org/zh-cn/民族资产解冻骗局" },
      { title: "危险协议", url: "javascript:alert(1)" },
      { title: "缺字段", url: "" },
    ],
  },
  { op: "update_node", id: "N_short", links: [{ title: "补充来源", url: "https://example.com/a" }] },
]);
check("候选卡与 links 更新全部应用", d2.applied === 2 && d2.errors.length === 0, d2.errors.join("|"));
const candLinks = node("N_cand")?.data?.links;
check("add_node links 只收 http(s)（危险协议剔除）",
  Array.isArray(candLinks) && candLinks.length === 2 && candLinks.every((l) => /^https?:\/\//.test(l.url)),
  JSON.stringify(candLinks));
check("update_node links 透传", node("N_short")?.data?.links?.[0]?.url === "https://example.com/a",
  JSON.stringify(node("N_short")?.data?.links));
// sanitize 装载边界：脏 links（非数组/危险 scheme）整条清掉；干净 links 原样保留
const san = sanitizeCanvas(
  [
    { id: "s1", type: "note", position: { x: 0, y: 0 }, data: { nodeType: "note", title: "t", body: "", links: "not-an-array" } },
    { id: "s2", type: "note", position: { x: 0, y: 0 }, data: { nodeType: "note", title: "t", body: "", links: [{ title: "x", url: "javascript:alert(1)" }] } },
    { id: "s3", type: "note", position: { x: 0, y: 0 }, data: { nodeType: "note", title: "t", body: "", links: [{ title: "ok", url: "https://ok.example" }] } },
  ],
  [],
);
check("sanitize 清脏 links（危险 scheme/非数组）、留干净的",
  san.fixedLinks === 2 &&
  san.nodes.find((n) => n.id === "s3")?.data?.links?.[0]?.url === "https://ok.example" &&
  san.nodes.find((n) => n.id === "s1")?.data?.links === undefined,
  `fixedLinks=${san.fixedLinks}`);
// —— 存量 note 卡 sanitize 尺寸归一（历史默认档 → 正文实算；research 卡同款先例）——
const upNote = (id, body, style, extra = {}) => ({
  id, type: "note", position: { x: 0, y: 0 }, style,
  data: { nodeType: "note", title: "存量", body }, ...extra,
});
const up1 = sanitizeCanvas([upNote("UP1", "字".repeat(210), { width: 280, height: 170 })], []);
check("存量 280×170 便签框 + 210 字正文 → 归一 440×211",
  up1.resizedNotes === 1 && up1.nodes[0].style.width === 440 && up1.nodes[0].style.height === 211,
  JSON.stringify({ n: up1.resizedNotes, s: up1.nodes[0].style }));
const up2 = sanitizeCanvas([upNote("UP2", "字".repeat(210), { width: 280, height: 170 }, { width: 300, height: 180 })], []);
check("用户手调过（顶层有尺寸）不归一", up2.resizedNotes === 0 && up2.nodes[0].style.width === 280,
  JSON.stringify(up2.resizedNotes));
const up3 = sanitizeCanvas([upNote("UP3", "短便签", { width: 280, height: 170 })], []);
check("短便签算出来与现值相同 → 不动不计数", up3.resizedNotes === 0 && up3.nodes[0].style.height === 170);
const up4 = sanitizeCanvas([upNote("UP4", "字".repeat(1302), { width: 480, height: 360 })], []);
check("上午分档期 480×360 策划卡 → 归一 560×698 全文可见",
  up4.resizedNotes === 1 && up4.nodes[0].style.width === 560 && up4.nodes[0].style.height === 698,
  JSON.stringify({ n: up4.resizedNotes, s: up4.nodes[0].style }));
const up5 = sanitizeCanvas([upNote("UP5", "字".repeat(210), { width: 440, height: 211 })], []);
check("归一幂等（动态尺寸不在历史档，再装载不计数）", up5.resizedNotes === 0);
// 画布摘要带 links 计数标记（agent 知道候选卡带出处，补研/引用时用）
const s2 = summarizeCanvas(
  useCanvasStore.getState().nodes,
  [],
  [],
  4000,
  7,
);
check("画布摘要候选卡行带「来源 N 条」标记", s2.includes("来源 2 条"), s2.split("\n").find((l) => l.includes("N_cand")) ?? "行缺失");

// —— 系列卡跨轮成列 + 同批收框（2026-09-09 罪案策划0909 项目散射事故：
// 11 卡跨轮逐张建、斜跨 2700×2800 无组框、集序视觉错乱）——
import { absolutePosition, nodeSize } from "../lib/canvas/store.ts";
// 1) 同批系列落卡：数组顺序=网格阅读序，group_nodes 占位 id 同批收框
const epBody = "字".repeat(150);
const dSer = applyOps([
  { op: "add_node", nodeType: "note", id: "EP_1", title: "第 01 集", body: epBody },
  { op: "add_node", nodeType: "note", id: "EP_2", title: "第 02 集", body: epBody },
  { op: "add_node", nodeType: "note", id: "EP_3", title: "第 03 集", body: epBody },
  { op: "group_nodes", ids: ["EP_1", "EP_2", "EP_3"], title: "测试·分集规划" },
]);
check("同批系列落卡+收框全部应用", dSer.applied === 4 && dSer.errors.length === 0, dSer.errors.join("|"));
const stSer = useCanvasStore.getState();
const grp = stSer.nodes.find((n) => n.data?.nodeType === "group" && n.data?.title === "测试·分集规划");
const kids = stSer.nodes.filter((n) => ["EP_1", "EP_2", "EP_3"].includes(n.id));
check("同批 group_nodes 占位 id 全解析进组框",
  Boolean(grp) && kids.every((k) => k.parentId === grp?.id),
  `group=${Boolean(grp)} parented=${kids.filter((k) => k.parentId === grp?.id).length}/3`);
const p1 = kids.find((k) => k.id === "EP_1").position;
const p2 = kids.find((k) => k.id === "EP_2").position;
const p3 = kids.find((k) => k.id === "EP_3").position;
check("数组顺序=网格阅读序（1→2 横排、3 换行）",
  p2.x > p1.x && p1.y === p2.y && p3.y > p1.y, JSON.stringify({ p1, p2, p3 }));
// 2) 跨轮续列：下一批纯 note 接在最近一张 note 卡正下方同列（x 不漂移）
const ep3abs = absolutePosition(stSer.nodes, kids.find((k) => k.id === "EP_3"));
const dNext = applyOps([
  { op: "add_node", nodeType: "note", id: "EP_4", title: "第 04 集", body: epBody },
]);
const ep4 = useCanvasStore.getState().nodes.find((n) => n.id === "EP_4");
check("跨轮纯 note 批次接在同列（x=最近 note 列位）",
  ep4?.position.x === ep3abs.x && ep4.position.y > ep3abs.y,
  `ep4=${JSON.stringify(ep4?.position)} ep3abs=${JSON.stringify(ep3abs)}`);
// 3) 混合批次（含资产）保持全局锚点：资产带语义不变
const globalMinX = Math.min(...useCanvasStore.getState().nodes.map((n) => n.position.x));
const dMix = applyOps([
  { op: "add_node", nodeType: "character", title: "混排角色", body: "设定" },
  { op: "add_node", nodeType: "note", id: "MIX_N", title: "混排便签", body: "混排正文" },
]);
const mixChar = useCanvasStore.getState().nodes.find((n) => n.data?.title === "混排角色");
check("混合批次资产带仍走全局锚点", mixChar?.position.x === globalMinX,
  `charX=${mixChar?.position.x} 全局minX=${globalMinX}`);

// —— 造型计划（looks）链路：ops 透传 / 物化幂等 / 未出图计划保留 ——
// 造型计划是角色卡的结构化数据（拆解产出）：造型图据此出图、分镜引用按行文
// 造型词自动选卡。此前只物化「已带图」的项，计划整条被丢弃（2026-09-10 修复）
const dLook = applyOps([
  {
    op: "add_node",
    nodeType: "character",
    id: "LK_CHAR",
    title: "冯太后",
    body: "北魏太后",
    // 混合合法/非法项：缺 label 的应被剔除；costumeId 由 agent 提供可保留
    looks: [
      { label: "朝服", description: "十二旒朝服", costume: "十二旒朝服" },
      { description: "没有造型名，应被剔除" },
      { label: "常服", costume: "素色常服", costumeId: "n_cos_1" },
      { label: "  " },
    ],
  },
]);
const lkChar = useCanvasStore.getState().nodes.find((n) => n.id === "LK_CHAR");
check(
  "ops add_node：角色卡 looks 透传（非法项剔除、字段保留）",
  lkChar?.data.looks?.length === 2 &&
    lkChar.data.looks[0].label === "朝服" &&
    lkChar.data.looks[0].description === "十二旒朝服" &&
    lkChar.data.looks[1].costumeId === "n_cos_1",
  JSON.stringify(lkChar?.data.looks),
);
check(
  "ops add_node：looks 不收出图产物字段（imageUrl/nodeId 由流程回填）",
  !("imageUrl" in (lkChar?.data.looks?.[0] ?? {})) &&
    !("nodeId" in (lkChar?.data.looks?.[0] ?? {})),
  JSON.stringify(lkChar?.data.looks?.[0] ?? {}),
);

// 物化：已出图但还没成卡的造型 → 建独立造型卡 + 角色→造型卡连线 + 回填 nodeId
const migrated = sanitizeCanvas(
  [
    {
      id: "CH_M",
      type: "character",
      position: { x: 0, y: 0 },
      data: {
        nodeType: "character",
        title: "冯氏",
        body: "北魏太后",
        looks: [
          { label: "朝服", description: "十二旒朝服", imageUrl: "/assets/a.png" },
          { label: "常服", description: "素色常服" }, // 未出图：应保留在卡上
        ],
      },
    },
  ],
  [],
);
const migNode = migrated.nodes.find((n) => n.id === "CH_M");
const lookCards = migrated.nodes.filter((n) => n.data?.nodeType === "image");
check(
  "sanitize：已出图造型物化成独立卡（角色→造型卡连线 + 回填 nodeId）",
  lookCards.length === 1 &&
    lookCards[0].data.title === "冯氏·朝服" &&
    migNode?.data.looks?.[0]?.nodeId === lookCards[0].id &&
    migrated.edges.some((e) => e.source === "CH_M" && e.target === lookCards[0].id),
  `cards=${lookCards.length} title=${lookCards[0]?.data.title} nodeId=${migNode?.data.looks?.[0]?.nodeId}`,
);
check(
  "sanitize：造型计划完整留在卡上（已物化的记账 nodeId + 未出图的计划都保留）",
  Array.isArray(migNode?.data.looks) &&
    migNode.data.looks.length === 2 &&
    migNode.data.looks[0].nodeId === lookCards[0].id &&
    migNode.data.looks[1].label === "常服" &&
    !migNode.data.looks[1].imageUrl,
  JSON.stringify(migNode?.data.looks),
);

// 幂等：把物化结果再喂一次 sanitize，不应重复建卡
const again = sanitizeCanvas(migrated.nodes, migrated.edges);
const lookCards2 = again.nodes.filter((n) => n.data?.nodeType === "image");
check("sanitize 幂等：二次装载不重复建造型卡", lookCards2.length === 1,
  `cards=${lookCards2.length}`);

// update_node 重写造型计划：已出图的产物字段必须保留（否则已出图的造型会
// 被当「待出」重复出图，nodeId 丢失后还会重复建卡）
useCanvasStore.getState().updateNodeData("LK_CHAR", {
  looks: [
    {
      label: "朝服",
      description: "十二旒朝服",
      imageUrl: "/assets/done.png",
      nodeId: "n_look_done",
    },
    { label: "常服", costume: "素色常服" },
  ],
});
applyOps([
  {
    op: "update_node",
    id: "LK_CHAR",
    looks: [
      { label: "朝服", description: "描述被改过", costume: "十二旒朝服" },
      { label: "常服", costume: "素色常服" },
      { label: "雨夜装", description: "新增第三套" },
    ],
  },
]);
const afterUpd = useCanvasStore
  .getState()
  .nodes.find((n) => n.id === "LK_CHAR")?.data.looks;
check(
  "ops update_node：重写造型计划保留已出图产物（imageUrl/nodeId 不丢）",
  afterUpd?.[0]?.imageUrl === "/assets/done.png" &&
    afterUpd?.[0]?.nodeId === "n_look_done" &&
    afterUpd?.[0]?.description === "描述被改过",
  JSON.stringify(afterUpd?.[0]),
);
check(
  "ops update_node：新造型照常追加（计划字段生效）",
  afterUpd?.length === 3 && afterUpd?.[2]?.label === "雨夜装",
  JSON.stringify(afterUpd?.map((l) => l.label)),
);

// ---------- 主图覆盖前归档（2026-09-10 改图闭环修复的纯函数回归）----------
// agent 经 canvas_ops 回填 imageUrl 原本是纯覆盖：通道 A（改设定重出）在聊天里
// 执行会丢旧图、无法回滚。现在覆盖前自动入版本档案，且**幂等**——前端生成路径
// 提交时已归档（旧图已是 versions 末条），不能再重复入一条。
applyOps([{ op: "add_node", id: "n_arch_1", nodeType: "image", title: "归档卡", body: "" }]);
applyOps([
  {
    op: "update_node",
    id: "n_arch_1",
    imageUrl: "/assets/a1.png",
    genPrompt: "第一次提示词",
    status: "ready",
  },
]);
const firstFill = useCanvasStore.getState().nodes.find((n) => n.id === "n_arch_1")?.data;
check(
  "归档：首次填图不产生版本档案（无旧图可归）",
  (firstFill?.versions ?? []).length === 0,
  JSON.stringify(firstFill?.versions),
);
applyOps([{ op: "update_node", id: "n_arch_1", imageUrl: "/assets/a2.png" }]);
const afterReplace = useCanvasStore.getState().nodes.find((n) => n.id === "n_arch_1")?.data;
check(
  "归档：覆盖主图把旧图入档并带当时提示词",
  afterReplace?.versions?.length === 1 &&
    afterReplace.versions[0].url === "/assets/a1.png" &&
    afterReplace.versions[0].prompt === "第一次提示词",
  JSON.stringify(afterReplace?.versions),
);
applyOps([{ op: "update_node", id: "n_arch_1", imageUrl: "/assets/a2.png" }]);
const sameAgain = useCanvasStore.getState().nodes.find((n) => n.id === "n_arch_1")?.data;
check(
  "归档：回填同一张图不重复入档（幂等）",
  (sameAgain?.versions ?? []).length === 1,
  JSON.stringify(sameAgain?.versions),
);
applyOps([{ op: "update_node", id: "n_arch_1", imageUrl: "/assets/a3.png" }]);
const twice = useCanvasStore.getState().nodes.find((n) => n.id === "n_arch_1")?.data;
check(
  "归档：再次换图 → 两版档案（a1、a2）",
  twice?.versions?.length === 2 &&
    twice.versions[0].url === "/assets/a1.png" &&
    twice.versions[1].url === "/assets/a2.png",
  JSON.stringify(twice?.versions),
);
// 前端已归档场景（链路三提交形态：旧图已入档、当前 imageUrl 仍是它）：
// 末档 == 当前图 → 跳过，不重复
useCanvasStore.getState().updateNodeData("n_arch_1", {
  imageUrl: "/assets/a3.png",
  versions: [
    { url: "/assets/a1.png", at: "01-01 00:00" },
    { url: "/assets/a2.png", at: "01-01 00:01" },
    { url: "/assets/a3.png", at: "01-01 00:02" },
  ],
});
applyOps([{ op: "update_node", id: "n_arch_1", imageUrl: "/assets/a4.png" }]);
const noDup = useCanvasStore.getState().nodes.find((n) => n.id === "n_arch_1")?.data;
check(
  "归档：前端已归档过的不重复（末档==当前图时跳过）",
  noDup?.versions?.length === 3 && noDup.versions[2].url === "/assets/a3.png",
  JSON.stringify(noDup?.versions),
);
// 视频同规
applyOps([{ op: "add_node", id: "n_arch_v", nodeType: "video", title: "视频归档卡" }]);
applyOps([{ op: "update_node", id: "n_arch_v", videoUrl: "/assets/v1.mp4" }]);
applyOps([{ op: "update_node", id: "n_arch_v", videoUrl: "/assets/v2.mp4" }]);
const vid = useCanvasStore.getState().nodes.find((n) => n.id === "n_arch_v")?.data;
check(
  "归档：视频覆盖同规（旧视频入档）",
  vid?.versions?.length === 1 && vid.versions[0].url === "/assets/v1.mp4",
  JSON.stringify(vid?.versions),
);

console.log(`\n${fail === 0 ? `全部通过（${pass} 项）` : `${fail} 项失败`}`);
process.exit(fail === 0 ? 0 : 1);

/**
 * 考据参考组框回归（2026-09-11 参考卡风暴善后）：sanitize 存量迁移 + 折叠组
 * 的数据契约。纯函数（sanitizeCanvas + store 种子），无 LLM 无浏览器。
 *
 * 背景：09-10 起对账把已采纳参考图物化成画布卡，旧落位「资产列下方各占一条
 * 横带」在冯太后项目（52 资产 × 3 张）抻成 2350×4100px 的画布 sprawl。新代码
 * 一律收进「考据参考」折叠组框；存量散卡由 sanitize 在装载边界收进组。
 *
 * 运行：pnpm dlx tsx scripts/ref-group-collapse-test.mjs
 * （.ts 后缀直引——node 原生 strip-types 不解析 extensionless import）
 */
import { sanitizeCanvas } from "../lib/canvas/sanitize.ts";
import { adoptRefRows } from "../lib/canvas/refAdopt.ts";
import { useCanvasStore } from "../lib/canvas/store.ts";

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? `  — ${detail}` : ""}`);
};

/** 造一张散落参考卡（旧落位形态：顶层、无 parentId、可见） */
function strayRef(id, x, y) {
  return {
    id,
    type: "image",
    position: { x, y },
    style: { width: 256, height: 200 },
    data: {
      nodeType: "image",
      title: `参考${id}`,
      imageUrl: `/agent-service/assets/${id}.jpg`,
      status: "ready",
      refSource: "research",
      refCandidateId: `c-${id}`,
    },
  };
}

// ---------- A. 存量迁移：散卡收进折叠组 ----------
{
  const asset = {
    id: "a1", type: "character", position: { x: 0, y: 0 },
    data: { nodeType: "character", title: "冯氏", body: "" },
  };
  const strays = [
    strayRef("r1", 400, 2000), strayRef("r2", 680, 2000), strayRef("r3", 960, 2000),
    strayRef("r4", 400, 2240), strayRef("r5", 680, 2240), strayRef("r6", 960, 2240),
  ];
  const edges = strays.map((s) => ({
    id: `e-${s.id}`, source: s.id, target: "a1",
  }));
  const r1 = sanitizeCanvas([asset, ...strays], edges);
  check("A1 六张散卡全部收进组", r1.regroupedRefs === 6, `regroupedRefs=${r1.regroupedRefs}`);
  const g1 = r1.nodes.find((n) => n.data?.refGroup === "research");
  check("A2 组框建成且默认折叠（172×40 胶囊）",
    Boolean(g1) && g1.data.collapsed === true && g1.style.width === 172,
    `collapsed=${g1?.data?.collapsed}`);
  check("A3 组框 prevSize 记住展开尺寸",
    g1?.data?.prevSize?.w > 800 && g1?.data?.prevSize?.h > 400,
    `prevSize=${JSON.stringify(g1?.data?.prevSize)}`);
  check("A4 散卡全部 parent 进组且 hidden",
    strays.every((s) => {
      const n = r1.nodes.find((m) => m.id === s.id);
      return n?.parentId === g1?.id && n?.hidden === true;
    }),
    "");
  check("A5 相对排布保留（卡间相对位置不变）", (() => {
    const n1 = r1.nodes.find((m) => m.id === "r1");
    const n2 = r1.nodes.find((m) => m.id === "r2");
    return Math.abs((n2.position.x - n1.position.x) - 280) < 1;
  })(), "");
  check("A6 连线原样保留（出图参考链路不断）",
    r1.edges.length === 6, `edges=${r1.edges.length}`);
  // 幂等：再跑一遍无散卡、不重建组
  const r2 = sanitizeCanvas(r1.nodes, r1.edges);
  check("A7 幂等：二次装载无散卡可收", r2.regroupedRefs === 0, `regroupedRefs=${r2.regroupedRefs}`);
  const groups2 = r2.nodes.filter((n) => n.data?.refGroup === "research");
  check("A8 幂等：组框不重复建", groups2.length === 1, `count=${groups2.length}`);
}

// ---------- B. 守卫：组已存在时，用户拖出来的小批量散卡不回收 ----------
{
  const group = {
    id: "g1", type: "group", position: { x: 0, y: 1000 },
    style: { width: 172, height: 40 },
    data: { nodeType: "group", title: "考据参考", refGroup: "research", collapsed: true, body: "" },
  };
  const inGroup = strayRef("r1", 16, 44);
  inGroup.parentId = "g1";
  inGroup.hidden = true;
  const draggedOut = [strayRef("r9", 500, 300)]; // 用户从组里拖出来的单卡
  const r = sanitizeCanvas(
    [group, inGroup, ...draggedOut],
    [{ id: "e1", source: "r1", target: "a1" }],
  );
  check("B1 组已存在时单张散卡不动（用户刻意的画布安排）",
    r.regroupedRefs === 0 && r.nodes.find((n) => n.id === "r9")?.parentId === undefined,
    `regroupedRefs=${r.regroupedRefs}`);
  // 但批量散卡（≥6，异常形态）仍收
  const many = Array.from({ length: 7 }, (_, i) => strayRef(`m${i}`, 400, 2000 + i * 224));
  const r2 = sanitizeCanvas([group, ...many], []);
  check("B2 组已存在但 ≥6 张批量散卡仍收（数据异常自愈）",
    r2.regroupedRefs === 7, `regroupedRefs=${r2.regroupedRefs}`);
}

// ---------- C. 新采纳落组（refAdopt.adoptRefRows 全链，种子 store） ----------
{
  const st = useCanvasStore.getState();
  st.replaceCanvas(
    [{ id: "a1", type: "character", position: { x: 0, y: 0 }, data: { nodeType: "character", title: "冯氏", body: "" } }],
    [],
    { x: 0, y: 0, zoom: 1 },
  );
  const cand = (i) => ({
    id: `c${i}`, title: `候选${i}`, assetUrl: `/agent-service/assets/x${i}.jpg`,
    sourceDomain: "baike.baidu.com",
  });
  const created = adoptRefRows([{ nodeId: "a1", candidates: [cand(1), cand(2), cand(3)] }]);
  const s1 = useCanvasStore.getState();
  const g = s1.nodes.find((n) => n.data?.refGroup === "research");
  check("C1 新采纳建组且折叠", Boolean(g) && g.data.collapsed === true, "");
  check("C2 三张卡全部进组且 hidden", created.length === 3 && created.every((id) => {
    const n = s1.nodes.find((m) => m.id === id);
    return n?.parentId === g?.id && n?.hidden === true;
  }), "");
  check("C3 连线到资产卡（出图参考通道）",
    created.every((id) => s1.edges.some((e) => e.source === id && e.target === "a1")), "");
  // 追加：不叠已有卡、组 prevSize 跟进
  const created2 = adoptRefRows([{ nodeId: "a1", candidates: [cand(4)] }]);
  const s2 = useCanvasStore.getState();
  const g2 = s2.nodes.find((n) => n.data?.refGroup === "research");
  const n4 = s2.nodes.find((m) => m.id === created2[0]);
  const bottoms = s2.nodes.filter((m) => m.parentId === g2.id && m.id !== n4.id)
    .map((m) => m.position.y + 200);
  check("C4 追加卡落在已有卡之下（不叠压）",
    n4.position.y > Math.max(...bottoms) - 1, `y=${n4.position.y}, 已有最低底=${Math.max(...bottoms)}`);
  check("C5 折叠态下 prevSize 同步扩张",
    g2.data.prevSize.h > g.data.prevSize.h, `prev ${g.data.prevSize.h} → ${g2.data.prevSize.h}`);
  check("C6 组不重复建", s2.nodes.filter((n) => n.data?.refGroup === "research").length === 1, "");
  // C7：折叠组展开后子卡可见性交给 toggleGroupCollapse（既有机制，此处只验
  // 数据面：hidden 卡仍在 nodes 里，服务端/前端参考收集都不过滤 hidden
  // ——契约由 ref-report-reconcile-test 的浏览器断言兜）
}

const bad = results.filter((r) => !r.ok);
console.log(
  `\n${bad.length ? "✗" : "✅"} 考据参考组框 ${results.length - bad.length}/${results.length} 项通过`,
);
process.exit(bad.length ? 1 : 0);

# 全景环视（P3-3）详细设计 Spec

> 2026-09-04 · 上游：[image-node-ops-spec.md](image-node-ops-spec.md) P3-3 占位条目。
> 事实依据：DMX 2:1 探针（2026-09-03，seedream-4-5 2816×1408 请求 → 输出严格 2:1）
> + open-storyboard-canvas 全景实现一手调研（panoramaPrompt.ts / panoramaNormalize.ts /
> PanoramaNode.tsx / promptTemplates.ts）。
> **2026-09-04 当日全量落地（v1 球形 2:1），回归 68/68**——探针矩阵与实现记录见 §5。

## 0. 范围

v1 只做 **720° 球形全景（2:1 等距柱状）**。360° 圆柱环绕（4:1）不做——seedream-4-5
最小像素 3,686,400 对 4:1 的可行档位组合未经探针，且 4:1 在我们全部通道的像素
边界内无已验证组合；等探通再扩。

## 1. 与 open-storyboard 范式的关键差异（为什么我们不抄三件东西）

open-storyboard 的三个存在理由在我们这儿不成立，v1 明确不做：

| 他们做 | 原因 | 我们 |
|---|---|---|
| 本地归一化（中心裁切+右缘羽化 panoramaNormalize.ts） | Dreamina 只支持固定比例集，最宽 21:9，必须掰回 2:1 并藏接缝 | seedream 通道**显式请求 2:1 即输出严格 2:1**（已探通）；若输出偏离，明示不掰比例（铁律） |
| smartBase 白底 2:1 参考图垫底 | 强制 i2i 画幅进全景 | 同上，显式 aspect 即达；合成参考图会污染我们的图N 编号契约 |
| 独立 panorama 节点类型 | 其查看器即节点本体 | 复用图片卡 + `data.panorama` 标记；不新增 nodeType（卡渲染器/摘要/工具全家桶白拿） |

保留借鉴的：**职责化中文 prompt 模板**（他们 battle-tested 的负面约束句式）、
**photo-sphere-viewer 做查看器**（~106KB，他们已验证的选型；three.js ~550KB 只给
导演台用，不进图片链路）。

## 2. 分层设计

### 2.1 目录层（agent/models.py）

- `"2:1"` 加进**已探通**条目的 `aspects`：`doubao-seedream-4-5-251128`
- 前置探针矩阵（动工第一步，每格真出一张图验证，遵循目录「DMX 实探验证」约定）：

| 模型 | 2:1 档位 | 像素边界（models.py 注） | 探针目标尺寸 |
|---|---|---|---|
| seedream-4-5 | 2K | ≥3,686,400 | 2816×1408（已通 ✅） |
| seedream-4-5 | 4K | ≥3,686,400 | 探（~4032×2016） |
| seedream-4-0 | 2K / 4K | 未注 | 探 |
| seedream-5-pro | 1K / 2K | ≤4,194,304（2K 上限 2880×1440） | 探（responses 通道） |

  探通的加 `aspects`，不通的不加——`resolve_aspect`（models.py:250-268）天然对
  不支持组合 400 点名，无需新校验代码。
- **前端零改动即获得**：ImagegenChips 画幅宫格吃目录 `opt.aspects`
  （PromptBar.tsx:1240,1366），seedream 卡上手动选 2:1 的旁路自动可用。

### 2.2 动作层（环视入口）

- `ImageToolDetail.tool`（lib/canvas/events.ts）加 `"panorama"`；顶部工具条与右键
  图片专属段的现有按钮族（nodes.tsx:918-955 / CanvasView.tsx:2406-2445）加一项
  「环视」，走 `dispatchImageTool(id, "panorama")` 现有通道
- **可见性**：场景资产卡 + 图片卡（环境主体）；角色/道具/服饰卡不出现（主体向
  卡做全景无意义，隐藏不置灰——三视图同款规则）；无图不出
- 遥测：`data-track="image.panorama"`

### 2.3 弹窗（ImageTemplateDialog 加 panorama 配置）

复用现有组件与管线（ImageTemplateDialog.tsx），差异点：

- 预设区不做 chips，改为**固定说明行**：「生成 2:1 球形全景图（720° 环视），
  新卡以本卡场景为参考」+ 空场景提示文案（源卡标题/设定摘要同 srcText 逻辑）
- 补充描述 textarea 照旧（`extra`）
- prompt 组装（职责化模板，open-storyboard promptTemplates.ts:217 直译适配）：

```
最终图片必须是等距柱状投影的完整球形全景图，比例2比1，宽度是高度的2倍，
只输出一张连续画面。水平视角覆盖完整360度，垂直视角覆盖从天空到地面的
完整180度，观看者位于场景中心，可以环视整个环境，地平线位于画面垂直中心
附近，左右边缘必须自然无缝衔接。画面中不要出现摄影师、相机、三脚架等
拍摄设备；不要分屏拼贴、多宫格、画中画；不要文字、水印、边框或明显接缝。
参考画面内容：{源卡设定/提示词摘要 CONTEXT_BODY_LIMIT}
{extra}
```

### 2.4 出卡管线（复用 GENERATE_EVENT，两处新键）

confirm 时建新卡（splitImageToGrid 摆位先例，源卡右侧 + 连线），**data 多两键**：

```ts
addNode({ position, data: {
  nodeType: "image",
  title: `${源标题} · 全景`,
  body: prompt,
  panorama: true,                      // 新字段：查看器与异常检测挂此标记
  gen: { aspect: "2:1", model: panoModel, resolution: "2K" },  // 不继承项目默认
}})
→ connect({source: 源卡, target: 新卡})
→ GENERATE_EVENT { nodeId:新卡, kind:"image", prompt, refIds:[源卡id] }
```

- **模型预校验（明示不静默换）**：confirm 前查 `loadImageModels()` 目录——
  项目默认模型若不支持 2:1，弹窗内明示「已预置 Seedream 4.5（当前默认模型
  {X} 不支持 2:1 全景）」并把新卡 `gen.model` 钉到目录里第一个 2:1 可用模型；
  目录里一个都没有（探针全灭的极端情况）→ 确认钮禁用 + 说明文案
- `gen.aspect="2:1"` 显式钉死，防 `resolveAutoAspect` 吸附参考图比例把画幅带偏
- 画风闸/参考序列/候选/补出/编排全部免费继承（对新卡发事件的现有语义）

### 2.5 查看器（photo-sphere-viewer，懒加载）

- 依赖：`@photo-sphere-viewer/core`（~106KB，竞品同款选型；**dynamic import**，
  仅全景卡首次打开环视时加载，不进主 bundle）
- 入口：全景卡（`data.panorama && imageUrl`）灯箱工具区加「环视」按钮 → 灯箱
  图片区切换为 PSV Viewer（equirectangular）；Esc/关闭回普通灯箱
- 配置从简（竞品配置裁剪）：`minFov 25 / maxFov 110 / navbar false / mousewheel
  true / moveInertia false`；滚轮=FOV、拖拽=环视
- 卡面不渲染查看器：仍是普通 2:1 静帧（LOD/缩略图/连线全家桶零改动）
- **比例异常明示**：加载前校验 `naturalWidth/naturalHeight`，偏离 2:1 超 ±8%
  （竞品同款容差）→ viewer 顶部横条「生成结果非 2:1（{实际比例}），环视可能
  失真，建议重新生成」，照常可看——载入前另有 crop+羽化矫形（§5.3 修订：
  竞品同款，接缝连续性的正路，非静默修正）

### 2.6 数据与摘要

- `WingNodeData` 加 `panorama?: boolean`（store.ts；sanitize 无迁移——新字段缺省
  即普通卡，无需回填）
- 画布摘要对全景卡附「（全景）」标记（canvas_summary 锚点行同款写法），
  agent 可知可指代；聊天出图工具不受影响（panorama 卡被 @ 时就是普通参考图）

## 3. 明确不做（v1）

- 圆柱 4:1 环绕、smartBase 白底（F 组探针证伪：seedream 白底垫图仍伪全景+
  留白残留，竞品用它对付 Dreamina 固定画幅，我们的目录已原生 2:1 无此需求）、
  独立 panorama 节点类型、three.js、截图/四宫格导出（竞品 PSV 截图四宫格——
  等环视被真实使用后再评估）、「导入本地图当全景」（竞品 sourceMode=image
  分支）

## 4. 落地记录（2026-09-04）

### 4.1 探针矩阵结果（全绿，经 /storyboard/images 真链路）

| 模型 | 2:1 档位 | 实际输出 | 判定 |
|---|---|---|---|
| seedream-4-5 | 2K | 严格 2:1（2026-09-03 探通） | ✅ |
| seedream-4-5 | 4K | 4320×2160（严格 2:1，JPEG 载荷） | ✅ |
| seedream-4-0 | 2K | 2880×1440（严格 2:1） | ✅ |
| seedream-4-0 | 4K | 4320×2160（严格 2:1） | ✅ |
| seedream-5-pro | 1K | 2048×1024（严格 2:1，PNG） | ✅ |
| seedream-5-pro | 2K | 2880×1440（严格 2:1，≤4.19M 上限内） | ✅ |

三模型全档通过，目录条目全数收录（agent/models.py 注释带实测尺寸）。
探针脚本：`scripts/_tmp/pano-probe.mjs`（gitignored；注：其结果字段读的是
`url`，实际接口回 `imageUrl`，复用时改一下）。

### 4.2 实现（与本档 §2 一致，差异备注）

- 目录：三 seedream 条目 `aspects += "2:1"`；画幅宫格零改动自动出现
- 入口：顶部工具条「环视」（场景/图片卡，角色/道具/服饰隐藏）+ 右键
  「全景环视…」双入口，走 IMAGE_TOOL_EVENT
- 弹窗：ImageTemplateDialog panorama 分支（固定说明+源摘要+模型预校验行）
- 出卡：新卡+连线+对新卡 GENERATE_EVENT，`panorama:true` +
  `gen={aspect:"2:1", model:预校验模型, resolution:"2K"}`；默认模型
  gpt-image-2 不支持 2:1 时明示「已预置 Seedream 4.0」（capable[0]）
- 查看器：`@photo-sphere-viewer/core` 5.15.1（three 为其依赖），Lightbox
  lazy import 懒加载；事件截停 wrapper（灯箱容器级 wheel/拖拽/点击关闭
  与 PSV 环视打架）；比例偏离 ±8% 顶部横条明示不掰比例
- 摘要：summarizeCanvas 对全景卡附「（全景）」标记
- 踩坑两枚：① stop→start 连跑撞 uvicorn 优雅退出，start_agent 的 is_up
  误判「已在运行」跳过启动（start_wingsight.sh 已知竞态，重跑 start 即真启动）；
  ② npmjs.org 直连在本机僵死（pnpm add 挂 30 分钟零进展），换
  `--registry=https://registry.npmmirror.com` 4 秒装完
- 回归：`node scripts/image-node-ops-test.mjs` **68/68**（P 组 11 项：
  可见性/预校验/panorama 标记/gen 钉死/连线/模板句/2:1 载荷/rid/ready/
  PSV 挂载/退出）；测试补自删项目（历史曾漏删积累 60 个垃圾项目）

### 4.3 验收

| 验收项 | 判定 | 状态 |
|---|---|---|
| 目录 | seedream 卡画幅宫格见 2:1；非 seedream 卡不见；手选 2:1 出图严格 2:1 | ✅ 探针全绿 |
| 入口 | 场景卡/图片卡见「环视」，角色卡不见；无图不出 | ✅ P1/A5-5 |
| 出卡 | 新卡连线、`gen.aspect=2:1`、默认模型不支持时明示预置 seedream | ✅ P2-P5 |
| 生成 | 走 GENERATE_EVENT 全管线（画风闸/参考编号/候选继承）；输出 2:1 | ✅ P6-P9 |
| 环视 | 灯箱「环视」懒加载 PSV，拖拽环视/滚轮 FOV；360° 无断裂 | ✅ P10/P11 |
| 异常 | 输出非 2:1 时横条明示；模型不支持时 400 点名文案可读 | ✅（横条代码路径随 ±8% 校验，探针未见偏离） |
| 回归 | image-node-ops-test.mjs 不回归 + 新增环视组 | ✅ 68/68 |

## 5. 伪全景事故与修复（2026-09-04，用户报「只生成了一张鱼眼的图」）

### 5.1 现象与根因

用户卡出图 2880×1440（比例对）但内容是**鱼眼圆框伪全景**：圆形画面+暗角+
单视角拉伸，左右边缘不衔接，PSV 环视严重失真。根因不是画幅（探针矩阵全绿），
是**内容几何**：v1 PANO_PROMPT 直译竞品时丢了三件防御——参考图角色句
（防拉伸）、鱼眼/圆框否定句、具体几何描述。

### 5.2 五组探针矩阵（scripts/_tmp/pano-*.mjs，seedream 2K 2:1 同场景）

| 组 | 变量 | 判定 | 结论 |
|---|---|---|---|
| A | 4-0 纯文生（v2 强化提示词） | 伪全景：单点透视+球面卷曲 | prompt 防圆框/暗角有效，几何无效 |
| B | 4-0 + 源图参考 | 伪全景：参考图被拉宽塞满 | 角色句挡不住硬拉伸 |
| D | 4-5 纯文生 | 伪全景：tiny-planet 泡泡球 | 换代更糟 |
| E | gemini + 白底 2:1 垫图 | 9:16 倒置（1536×2752），不继承画布尺寸 | DMX gemini 通道出局 |
| F | 4-0 + 白底 2:1 垫图 | 伪全景+上下留白残留 | 竞品 smartBase 对 seedream 证伪 |

**定论：在售模型画不出严格等距柱状几何，prompt 已到顶。** 竞品
open-storyboard 注释自证同境遇（Dreamina CLI 最接近画幅只有 21:9），他们的
上线方案 = 后处理矫形（panoramaNormalize.ts）：center-crop 到 2:1 + 左右
边缘 48px 线性羽化交叉淡化，"让环绕看起来连续，尽管模型从未被真正告知如何
闭合环路"。竞品上线的就是这个体验，不是模型魔法。

### 5.3 修复（分工：prompt 防形态缺陷，前端兜接缝）

- **PANO_PROMPT v3**（ImageTemplateDialog）：v2 探针验证有效的部分（参考图
  角色句/几何描述/鱼眼圆框球窗门洞禁令）+ 竞品否定句全集（普通横幅/宽银幕
  截图）。G 组真跑验证：**鱼眼圆框根除**、铺满画幅、环绕感良好；残余垂直线
  汇聚=模型能力边界，由矫形兜底
- **PanoramaViewer 载入前矫形**（竞品 panoramaNormalize 移植）：center-crop
  2:1（通常恒等，兜通道漂移）+ 右缘 48px 按 (1-t)^1.2 混入左缘条带——wrap
  359°→0° 接缝突变抹平；JPEG 0.92 dataURL（PNG 上 10MB+）。比例偏离 ±8%
  横条明示保留（矫形是产品决策不是静默修正）；§2.5「不本地裁切掰比例」条款
  就此修订——crop 只兜异常，羽化是正路
- 回归 **87/87**（P6 断言词「等距柱状投影」「2比1」在 v3 中保留；PSV 挂载
  走异步矫形后仍过，懒加载链路无恙）

### 5.4 3D 体验显性化（用户二次反馈「没搞成 3D 解析，还是平面图」）

§5.3 修的是图像内容质量；用户主诉的另一半是**体验**——3D 入口原来埋在
「选中卡→工具条小图标」/「开灯箱→再点环视」两层深处，生成完只见平面静帧，
用户根本发现不了球形查看。三层显性化：

- **生成完成自动弹 3D**：全景卡首图 null→到位翻转时灯箱自动开且直进球形
  模式（`initialPano`）。prevRef 首帧记初值——装载/刷新时图早已存在不算
  翻转不弹；React Compiler 禁 effect 引用后声明绑定，openZoom（纯函数无
  hooks）上移到 effect 之前
- **卡面常驻「720° 环视」钮**：panorama 卡媒体区左下角 pill（LOD full 档），
  一键直进球形模式；与灯箱钮同 aria-label，测试按 `data-track` 消歧
  （card.panorama.view / lightbox.panorama）
- 弹窗 hint 改为「完成自动进入 720° 拖拽环视」——事前讲明预期

回归 **90/90**（新增 P9.5 自动弹挂载 / P9.6 Esc 关闭 / P9.7 卡面钮直进）。
§2.5「卡面不渲染查看器」维持（卡面仍是静帧+入口钮，查看器只在灯箱）。

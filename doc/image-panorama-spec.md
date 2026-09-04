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
  失真，建议重新生成」，照常可看——不本地裁切掰比例

### 2.6 数据与摘要

- `WingNodeData` 加 `panorama?: boolean`（store.ts；sanitize 无迁移——新字段缺省
  即普通卡，无需回填）
- 画布摘要对全景卡附「（全景）」标记（canvas_summary 锚点行同款写法），
  agent 可知可指代；聊天出图工具不受影响（panorama 卡被 @ 时就是普通参考图）

## 3. 明确不做（v1）

- 圆柱 4:1 环绕、本地归一化羽化、smartBase 白底、独立 panorama 节点类型、
  three.js、截图/四宫格导出（竞品 PSV 截图四宫格——等环视被真实使用后再评估）、
  「导入本地图当全景」（竞品 sourceMode=image 分支）

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

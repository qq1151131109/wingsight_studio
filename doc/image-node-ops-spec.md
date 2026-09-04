# 图片节点操作层优化 Spec

> 2026-09-03 · 依据：8 个 references/ 画布竞品调研（novanova-studio、open-ai-canvas、
> open-storyboard-canvas、Storyboard-Copilot、viedeo-workflow、AIGCCanvasFlow、
> OpenLovart、ai-moive-studio）+ 本项目图片卡现状盘点。
> 2026-09-03 复核：行号按 d3b77210c 工作树逐条重对，竞品结论按一手调研二次校验
> （open-ai-canvas 超分、P2 管线语义等 6 处修正，新增 P1-3/P3-3 与人物质感）。
> 范式结论：生成链路（参考机制/候选/版本/提示词工程）我们不落后且多项领先；
> 缺的是「看图干活」的图片操作层，以及动作落位与竞品主流相反的问题。

## 1. 现状与问题

现有能力（不重做）：候选+设为主图+失败补出、版本档+genPrompt 回滚+A/B 对比、
标注重绘（MaskEditDialog）、九宫格切图（splitImageToGrid 出新卡连线）、看图反推、
智能编排、@/连线/本卡原图三通道参考、上传替换（旧图入版本档）。

问题两条：

1. **动作层缺失**：裁剪、放大超分、扩图、多视角、三视图、打光——8 个竞品里
   5 家有真实现（open-storyboard-canvas、open-ai-canvas、Storyboard-Copilot、
   novanova-studio、viedeo-workflow），我们一项没有。
   **防坑**：AIGCCanvasFlow 首页宣传的「9/25 宫格/三视图/多机位/360° 环绕/
   灯光景深/无损放大」与 OpenLovart 的「替换背景/Mockup」按钮均**无任何实现**
   （空壳文案），对标时不计入、勿采信。
2. **落位反常**：竞品主流是「卡上轻（下载/复制图/裁剪/切图）→ 右键重（AI 动作）
   → 灯箱纯看」三明治；我们把下载/复制图都塞进灯箱，右键对图片卡零专属项，
   轻动作也要两次点击才够到。

## 2. 设计原则

- **范式不动**：维持 B 派（编辑框跟随选中卡，PromptBar）；不上 A 派（独立编辑器
  节点）。左右「+」手柄建连卡已是 A 派语义的补充，够用。
- **落位（2026-09-03 按用户反馈修订：右键太深）**——竞品五家共识（open-ai-canvas /
  novanova / open-storyboard-canvas / Storyboard-Copilot / viedeo-workflow）都是
  **选中卡上方悬浮工具条**为主入口：
  - **顶部工具条**（CardShell NodeToolbar，选中即现）= 图片操作主入口：
    裁剪/多视角/三视图(角色)/打光/人物质感/自由缩放 图标钮直发 IMAGE_TOOL_EVENT
  - 图片卡角落簇已**整体上浮进工具条**（2026-09-03 用户定稿：卡面只显示
    图片，V/复制提示词/下载/复制图片/重新生成/⌕ 全在工具条 CardShell
    extraTools 插槽；图片卡 bleed 满幅、去提示词文字——提示词在数据里保留，
    选中卡输入条可见可改，右键可复制）
  - 资产卡保留角落簇（更换/下载/复制/⌕）
  - 右键图片专属段 = 备份路径（保留，含复制出图提示词等低频项）
  - 灯箱 = 看图 + 已有的成品级动作（标注重绘/九宫格/设为主图/版本恢复），不加新
- **非破坏式**：像素级改图（裁剪）走「原位替换 + 旧图自动入版本档」（与标注重绘
  同范式；竞品之所以一律另出 (n+1) 张新卡，是因为它们没有统一版本档可回滚）；
  生成类动作（多视角/三视图/打光）产物一律**新图片卡 + 连线**（九宫格切图摆位
  先例）。
- **闸与报错**：生成类动作全部复用 GENERATE_EVENT 管线，画风闸在桥接层
  （CanvasAgentBridge.tsx:79-87）免费获得；失败明报不降级（架构铁律）。
- **portal 铁律**：一切新弹窗走 OverlayModal（卡内弹层裁剪教训见 AGENTS.md 已知坑）。
- **图片交互（2026-09-03 修订，竞品五家共识：单击只选中、预览是显式动作）**：
  - 单击图片 = 仅选中卡（原"点击即弹大图"废除——误触率高且打断选择流）
  - **双击图片 = 视口平滑聚焦本卡，统一观感尺寸**（不论卡片本身大小，聚焦后
    占画布可视区 ~78%：按卡片实测尺寸算目标 zoom，以 min=max=zoom 的
    fitView 强制该档居中——fitView 自带 maxZoom 只钳不放，小卡会留在原档；
    早期 0.78 下限/1.25 上限两版都因卡尺寸差异被推翻）
  - 灯箱入口 = 角落簇 ⌕「查看大图」按钮（图片卡/资产卡均有；标注重绘/九宫格/
    设为主图/版本恢复仍只在灯箱内做）
  - 工具条防出屏：选中卡贴近视口顶部时 offset 钳制（压在标题行上不裁掉）

## 3. 分期

### P0 动作归位（无新能力，纯落位）

**P0-1 角落簇加「下载」「复制图片」**

- 位置：缩略图右上角 CornerActions（组件 nodes.tsx:848，图片卡使用 :1986-2030），
  加在「复制提示词」旁
- 实现：**共享函数已存在**——`lib/download.ts` 的 `downloadMedia`（:23）与
  `copyImageToClipboard`，Lightbox 只是 import 使用（按钮区 Lightbox.tsx:336-371）。
  角落簇直接 import 调用即可，无抽取工作；下载原图不走 thumbs；复制失败的
  剪贴板权限报错与灯箱同文案（可直接复用其 runAction busy 态写法）
- 遥测：`data-track="image.download"` / `"image.copy-image"`（与灯箱
  `lightbox.download` 区分入口）

**P0-2 右键菜单图片专属段**

- 位置：CanvasView.tsx 节点右键菜单（onNodeContextMenu :1899，node 菜单渲染块
  :2333 起），`nodeType==="image"` 且有图时插入分组：下载图片 / 复制图片 /
  复制出图提示词（有 genPrompt 才出）
- 本段是后续 P1/P2 重动作的统一挂点，菜单项按分期逐个补
- 回归：无图空卡不出现该段；锁定卡右键行为不变

### P1 基础编辑（纯前端）

**P1-1 裁剪**

- 入口：右键图片专属段（竞品范式：Storyboard-Copilot/novanova/open-ai-canvas
  均为 工具条或右键 → 弹窗；**不进灯箱**，见设计原则「灯箱不再加新」）
- 交互：弹窗（OverlayModal，MaskEditDialog 的 `min(92vw,1400px)` 大屏先例）——
  画布区 8 向手柄 + 三分线参考线 + 比例预设（自由/1:1/16:9/9:16/4:3/3:4，novanova
  crop-dialog 范式）+ 实时像素尺寸显示 + 确认/取消
- 产物：canvas 裁块 → 走现有上传管线（图片卡 onFile nodes.tsx:2428，旧图自动入
  版本档 `.slice(-12)`）原位替换；原图任何时刻可从版本档恢复
- 技术：裁块与上传复用 splitImageToGrid（nodes.tsx:2279）已验证的
  canvas→blob→upload 代码，抽公共函数
- 边界：极小裁剪区（<16px）确认钮禁用；加载中禁重复打开
- 回归：Playwright——裁剪后 imageUrl 更新、versions +1、撤销可回滚整卡数据

**P1-2 锁比例/自由缩放切换**

- 现状：NodeResizer（nodes.tsx:697）`keepAspectRatio={aspect}`，图片卡
  aspect=`Boolean(d.imageUrl)`（:1952）——**有图即锁**，无法自由拉
- 方案：`data.freeResize?: boolean`；自由态解除锁定，切回锁定时按原始图片比例
  回弹当前尺寸（novanova 范式：freeResize 字段见其 canvas/types.ts:133）
- 入口：右键图片专属段「锁定比例/自由缩放」toggle；角落簇不加（低频）
- 回归：切换后 resize 行为、回弹比例计算

**P1-3 宫格合成导出**（九宫格切图的逆操作，Storyboard-Copilot 独有）

- 功能：把多张分镜帧合成一张 rows×cols 大图导出——帧编号（S1/S2…）、帧备注、
  单元格间距/外边距、背景色、cover/contain 填充、最大边长 clamp
  （参考 Storyboard-Copilot `merge_storyboard_images`，src-tauri/commands/image.rs:801）
- 入口：分镜表卡导出菜单 + 右键多选图片（selection 菜单已有挂点）
- 实现：纯前端 canvas 排版（帧图走 thumbs→原图两档），零 API
- 价值：分镜表/四视图交付给制片的常规格式，现在只能靠手动拼

### P2 模板化图生图动作（多视角 / 三视图 / 打光 / 人物质感）

四者同一机制，一个弹窗组件 + 四张预设表，共用「模板化重新生成」管线：

```
入口（右键图片专属段）→ 预设 chips 弹窗（可叠加一段自定义补充描述）
→ 组 prompt = 模板句 + 源卡 genPrompt/body 摘要（CONTEXT_BODY_LIMIT=500）
→ 建空图片卡（源卡右侧，splitImageToGrid 摆位先例）+ 源卡→新卡连线
→ dispatch GENERATE_EVENT { nodeId:新卡id, kind:"image", prompt, refIds:[源卡id] }
  （载荷=GenerateDetail，PromptBar.tsx:88；新卡无本卡原图，参考经「上游连线卡」
   通道收源卡图——refSequence 三通道天然支持）
→ 产物 = 新图片卡，标题「{源标题} · 视角:正面」式
```

- **⚠️ 禁止对源卡本身 dispatch**：GENERATE_EVENT 是对 nodeId **原位生成**
  （桥接层 directImagegen，CanvasAgentBridge.tsx:617 起），对源卡发会把源卡图
  覆盖掉（旧图进版本档）——「衍生新卡」必须先建卡再对新卡发事件
- 生成本体不新写，GENERATE_EVENT 管线带出来的候选/补出/遥测全部继承；
  新卡首图无版本档可入（空卡首生成，正常）
- **多视角**：预设 正面/左侧/右侧/背面/俯拍/仰拍（open-ai-canvas angle-dialog
  同款六预设）+ 自定义机位输入框；模板句式「同一{角色/场景}的{视角}视角，保持
  人物长相、服装、场景与参考图一致，仅改变机位」——后续可接导演台语汇
  （camera.py 经 /agent-service/camera-vocab）扩展成完整运镜模板，v1 不接
- **三视图**：仅当源卡是 角色资产卡 或其设定图（nodeType 判定）出现；模板=
  「同一角色三视图设定图：正面/侧面/背面 全身立绘，纯色背景，服装道具细节一致，
  标准角色设定图排版」；风格预设（写实/动漫/插画）chips 可选（viedeo-workflow
  ThreeViewOptionsModal 同款维度）
- **打光**：8 预设（伦勃朗/黄金时刻/赛博朋克/落日逆光/冷蓝月光/低调暗调/高调
  平光/雨夜霓虹），模板句式「保持画面内容与构图不变，改为{光效}」
  （open-storyboard LightingControlPanel 同思路，预设表自拟）
- **人物质感**（可选第四表，open-ai-canvas canvas-portrait-texture.ts 范式）：
  5 组滑块（人景融合/光影融合/皮肤/纹理/锐度）→ 中文 prompt 片段拼接，同一管线
  零边际成本
- 边界：源卡 loading 中禁触发；三视图入口对非角色卡隐藏（不置灰）
- 遥测：`data-track="image.multiview" / "image.turnaround" / "image.lighting"`
- 回归：Playwright mock 出图（shotref-binding-test 范式）——断言 GENERATE_EVENT
  载荷（nodeId 指新卡、prompt 含模板句、refIds 指源卡）、新卡落位与连线、
  画风闸拦截路径

### P3 需调研立项（先探通道再动工）

**2026-09-03 调研结论（模型清单 API 免费探 + seedream-4-5 实测一张）：**

**P3-1 放大/超分**：DMX 全量 553 个模型**零超分模型**（无 upscale/esrgan/enhance
系命中）→ 按「没有就不做」铁律，**真超分不做**。可选替代 = open-storyboard
的两遍精修管线（第一遍出黑白结构线稿做结构锚，第二遍原图+线稿精修；本质
普通图生图，走现有 DMX 编辑通道 + `/storyboard/images` 异步 job 范式，
不走 Langflow）。本地插值假超分明确不做。

**P3-2 扩图 outpaint**：gpt-image 系走 DMX images/edits 透传 OpenAI 协议，
理论支持 mask+size 扩图（OpenAI 原生 outpaint 范式），**未实测**——需带图
带蒙版实测一次才有结论，动工前先探。seedream 系 edit 通道无显式画布扩展
参数。

**P3-3 全景图**：详细设计已补档 → [image-panorama-spec.md](image-panorama-spec.md)
（2026-09-04）。要点：v1 只做球形 2:1（探针矩阵先行，4:1 等探通再扩）；不抄竞品
本地归一化/smartBase（我们显式 2:1 请求即严格输出）；photo-sphere-viewer ~106KB
懒加载做灯箱环视；复用 IMAGE_TOOL_EVENT + GENERATE_EVENT 管线，新卡钉
`gen.aspect="2:1"` + `panorama` 标记。原探针结论：seedream-4-5 实测 2:1 通过
（2816×1408 → 严格 2:1，2026-09-03）；像素边界：seedream-4-5 最小 3,686,400px
→ 2:1 最小 2720×1360；seedream-5-pro 响应通道上限 4,194,304px → 2:1 最大
2880×1440（4:1 全景超限，只能 2:1）。gpt-image-2 的 size 是固定枚举，2:1 未见支持。

以上动工前各补详细 spec，本档只占位。

## 4. 明确不做

- **图生视频**：战略缺口但依赖供应商选型（见项目记忆「视频执行层缺口」），另立项
- **抠图/擦除**：影视流程低频，竞品仅 open-storyboard 有（其抠图= prompt+蒙版走
  编辑模型，效果无保证，不是真 matting）
- **表情/情绪编辑**（open-ai-canvas 25 宫格情绪）：绑死 OpenAI 多参考编辑协议
  （竞品内部注释明言），影视流程低频；日后要做走 seedream edit 通道另评估
- **本地插值放大**：假超分（open-ai-canvas 的「放大」即是），与 P3-1 铁律一致
- **预测前后帧/情节推演/连续分镜**（open-storyboard 多功能面板七件套）：本质是
  分镜创作模板而非图片节点操作，落点应在分镜表卡/提示词模板侧，不属本档；
  P2 的模板管线机制建立后，若要做可直接复用
- **A 派编辑器节点**、灯箱加动作、批量候选堆叠展开范式（现有卡内候选条够用）
- **多选批量模板动作**（viedeo-workflow 的多选反推）：等单卡验证价值再说
  （P1-3 的多选合成导出除外——它是交付产物拼装，不是生成动作）

## 5. 验收清单

| 项 | 状态判定 | 状态 |
|---|---|---|
| P0-1 | 有图图片卡角落簇见 下载/复制图片，点击即生效，遥测落库 | ✅ 2026-09-03 |
| P0-2 | 图片卡右键见专属段；空卡/他类型卡不出现 | ✅（含资产卡出段；三视图仅角色卡） |
| P1-1 | 裁剪→原位替换+版本+1，比例预设与手柄可用，撤销可回滚 | ✅ ImageCropDialog（data-handle+稳定回调过 React Compiler refs 规则） |
| P1-2 | 右键切自由后可任意拉伸，切回锁定按图比例回弹 | ✅ data.freeResize + CardShell keepAspectRatio 组合；切回锁定异步按原图比例回弹（保宽调高） |
| P1-3 | 多选图片/分镜表卡 → 合成大图下载，帧编号与间距正确 | ✅ lib/canvas/gridMerge.ts；多选右键「合成宫格导出」+ 分镜表底栏「宫格图」（镜N 编号+画面备注） |
| P2 | 四个动作各自出 预设弹窗→新卡连线（源卡图不被覆盖），事件载荷正确，无画风时被闸拦截并弹画风窗 | ✅ 四件全（多视角/三视图/打光/人物质感）+ ImageToolDialogs 全局单例（IMAGE_TOOL_EVENT） |
| P3 | 调研结论落档后另立验收 | 调研已落档（超分不做/扩图待实测/2:1 已探通） |

回归：`node scripts/image-node-ops-test.mjs`（菜单段/建卡连线/源图不覆盖/
载荷字段——compose 开时模板句走 instruction/画风闸不发任务/裁剪替换+版本+撤销/
自由缩放切换/宫格导出下载）。

全部 P0+P1+P2 已于 2026-09-03 分两批落地；P3 动工前按上文调研结论各补 spec。

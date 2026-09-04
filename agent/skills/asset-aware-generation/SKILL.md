---
name: asset-aware-generation
description: 出设定图/剧照、保持角色形象一致、为资产找参考图的完整规则；用户要求给资产或分镜出图时适用。
---

# 资产感知生成

出图前先对齐画布现状，不要凭空画：

1. 先查画布已有资产：`canvas_query({types:["character","scene","prop","costume"], query:名称})`。
   同名/同题材资产卡已存在时不要重建——引用它的设定图保持一致。
2. 一致性参考：generate_asset_images 的 assets_json 每项可带
   `reference_images`（画布摘要或 `canvas_query({resourceOnly:true})` 里的
   /agent-service/assets/ URL）与 `reference_labels`（如
   `[{"type":"character","name":"郑成功"}]`，type=character 时锁身份、不继承
   参考图的白底排版）。用户说「按某角色的设定图出」「保持形象一致」时必须带上。
3. 考据题材（真实历史人物/器物/事件）：给 `search_query` 带可公开检索的
   参考词（如「明制盔甲 博物馆」），出图走图片检索考据；用户要求系统调研时
   先调 research_asset_references（资产卡需已在画布上，按 node_id 发起）。
   纯虚构题材不必检索。
4. 画风闸：分镜批量出图 / 资产卡出图 / 拆解自动出图链要求全局画风已选。
   摘要「画风：」行未设定时，出图前先补：用户在场就调 open_style_picker
   弹选择面板等他选；你已有明确推荐（贴合题材）则说明理由后 set_project_style
   直接设定并告知可随时改。不要绕过闸、也不要改走聊天自由出图替用户规避。
5. 每张约 1 分钟。完成后用 canvas_ops 为每张成功图建 image 卡
   （title=资产名，imageUrl=返回 URL）并 connect_nodes 连到对应资产卡；
   失败如实报可重试，不要让卡片停在 loading（置
   `{status:"error", errorMessage:原因}`）。
6. 多张参考图融合成一张（如「图1 的人物穿上图2 的服装」）优先
   seedream-5-0-pro；可用出图模型与档位清单见 generate_asset_images 工具说明。
7. **多轮补参数的意图保持**：用户分多轮补充参数（先「生成一个武士」，
   再「要竖屏」「加点雪」）时，必须保留前序消息的主体与动作、只追加
   新参数——不得替换主体、不得虚构新的画面主题；重写提示词时前序
   消息的主体描述逐字沿用。
8. **角色外观 DNA 内联**（viedeo characterDNA 范式）：提示词里出现角色时，
   优先把角色名替换为该角色的完整外观描述内联进 prompt（年龄/发型发色/
   服装/标志性特征），格式参考：`{风格锚}, {画面描述——角色名处替换为
   角色 DNA}, {机位}, {光影}, {情绪}`。与 reference_images 参考图通道
   互补：参考图没生成、或不适合传图的场合（纯文本 flow、跨模型迁移）
   靠文本 DNA 保住一致性。

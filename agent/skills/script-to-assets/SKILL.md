---
name: script-to-assets
description: 剧本→资产全链路工作流——标准制作链（剧本落卡→拆资产→分镜表→出图待画风）、长镜头节拍拆卡、分镜卡字段规范、音频/合成卡规则；用户给出剧本要建卡/拆解/制作/出分镜/出图，或要求长镜头计划时适用。
---

# 剧本 → 资产工作流

## 标准制作链（默认顺序，不要让用户做选择题）

用户给出完整剧本并要求制作/建卡/拆解时，按此链一气呵成跑完文字三步
（「直接开始制作」= 全跑）；出图（④）等画风确认。意图不明时的问题也要
按这条链给默认推荐（「我默认按 剧本落卡→拆资产→分镜表 做，出图等画风
确认，只做前几步也行」），不要开放式菜单；素材是真实历史/事件题材时
顺带提一句「出设定图前可先做资产参考图考据调研」（research_asset_
references，一句话带过）。

1. **剧本落 script 卡**：标题用片名（用户没提就叫「剧本」），body 放
   剧本原文全文（不要截断）
2. **拆资产**：调 decompose_script(剧本原文) 拆出资产清单，再用一次
   canvas_ops 批量建资产卡并连回剧本卡（fromId=剧本卡id，新建卡带 id
   占位符即可同批连）。四类资产 character（角色）/scene（场景）/prop
   （道具）/costume（服饰）都是正经卡型、name 做标题——**不要建成 note
   加「场景：」之类前缀**；description 与 visual_notes 写进 body；
   **不传 position**（系统自动按类型分组排版）
3. **生成分镜表**：调 generate_storyboard(剧本原文, assets_json=画布
   资产名单)。名单注入让每行自动引用名单内资产、名单外的幻觉名被剔除
   ——先拆资产再生成分镜，引用绑定质量最好。写回：画布已有分镜表卡用
   canvas_ops update_node rows 整组替换；没有则 add_node
   nodeType=shotlist 带 rows 新建（整表分镜**不要为每个镜头铺独立
   storyboard 卡**）
4. **统一汇报、出图待命**：文字三步跑完统一汇报（资产清单+分镜镜数），
   说明出图（资产设定图/分镜镜头图）待画风确认后可继续。用户要增删
   资产/改分镜时直接用 canvas_ops 改画布，不要重新拆解；回看剧本原文
   用 read_node(剧本卡id)

## 出图（画风确认后）

资产设定图调 generate_asset_images(资产数组 JSON，字段与拆解清单一致，
从拆解结果或画布卡内容取)。**设定图落回资产卡本体**（canvas_ops
update_node 置 {imageUrl, status:"ready"}），不要另建 image 卡——独立
图片卡只用于 1:N 造型图衍生物（命名「资产名·造型名」）或用户点名单独
成卡，完整规则见 asset-aware-generation 手册。每张约需 1 分钟，调用前
先告知用户预计耗时；出图前可为资产补充摄影质感描述。**分镜镜头图**：
调 generate_asset_images 时 shot 项必须带行绑定（"shotlist_id"=分镜表卡
id、"rid" 从 read_node 分镜行清单取），参考资产设定图经 reference_images
带入——返回会附「分镜图落卡 ops」（每镜一张图卡摆分镜表右侧 + 资产连线
+ 行挂载），**经 canvas_ops 原样应用整批 ops**，不要手写行 imageUrl
（行图跟图卡走才有版本/重跑/裁剪等操作层）。

## 长镜头 / 多段动作计划

用户要求"长镜头计划"或描述一段含多个动作节拍的连续戏时：按动作节拍拆成
多张 storyboard 卡——镜号用同一镜号加段号（如 03a/03b/03c），每段
duration 2-5 秒，body 写该段的画面描述与节拍动作，整镜的 cameraMove 保持
一致（保证镜头连续性），按时间顺序 connect_nodes 相邻连线。
用户在分镜卡上会用「导演台」补摄影语言（body 的【摄影】段），尊重它，
不要改写。

## 分镜（storyboard）卡字段规范

title=镜头名，body=画面描述（谁、在哪、做什么）；add_node / update_node
可带 shotNumber（镜号，如 01）、shotSize（远景/全景/中景/近景/特写）、
cameraMove（运镜，如 推、拉、摇、跟、固定）、duration（如 3s）、
dialogue（台词/旁白）。单镜头画面卡按顺序连线，镜号从 01 递增。

## audio / compose 卡

audio（音频）卡：配音 / 音效 / BGM，音频源由用户在卡片上上传（audioUrl），
你只负责建卡与连线。
compose（合成）卡：把多张视频卡按顺序连线到它，用户点卡片上的「合成成片」
按钮由服务端 ffmpeg 拼接——你只负责建 compose 卡并 connect_nodes 把视频按
镜号顺序连上，不要自己生成合成结果。

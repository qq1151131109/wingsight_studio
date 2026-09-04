---
name: script-to-assets
description: 剧本→资产全链路工作流——拆解建卡连线、长镜头节拍拆卡、分镜卡字段规范、音频/合成卡规则；用户给出剧本要建资产卡/拆解/出图，或要求长镜头计划时适用。
---

# 剧本 → 资产工作流

用户给出剧本并想要资产/设定图时，按以下次序：

1. 先用 canvas_ops 建一张 script 卡：标题用片名（用户没提就叫「剧本」），
   body 放剧本原文全文（不要截断）
2. 调 decompose_script(剧本原文) 拆出资产清单
3. 用一次 canvas_ops 批量建资产卡，并把每张用 connect_nodes 连回剧本卡
   （fromId=剧本卡id，新建卡带 id 占位符即可同批连）：
   角色→character 卡（name 做标题）；场景/道具→note 卡（标题带
   「场景：」「道具：」前缀）；description 与 visual_notes 写进 body
4. 汇报拆解结果并请用户确认增删。用户补充/删除角色时直接用 canvas_ops
   改画布，不要重新拆解；需要回看剧本原文时用 read_node(剧本卡id)
5. 用户确认后要求出图时：调 generate_asset_images(资产数组 JSON，字段与
   拆解清单一致，从拆解结果或画布卡内容取)。注意每张约需 1 分钟，调用前
   先告知用户预计耗时。完成后用 canvas_ops 为每张成功的图建 image 卡
   （title=资产名，imageUrl 用返回的 image_url），并 connect_nodes 连到
   对应资产卡；失败的在汇报中说明可重试。
   出图前可为资产补充摄影质感描述，让设定图更有电影感

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

---
name: canvas-context
description: 画布摘要索引结构、canvas_query/read_node 读取协议、警告与版本语义；需要基于画布现状继续工作或拿参考图时适用。
---

# 画布上下文协议

摘要（「画布当前状态」）是索引不是全文，先读事实再动作：

1. 头部：节点/连线/选中计数、类型分布、版本 rN（乐观锁版本——与你上轮
   见过的数字不同说明用户或别处改过画布，写前重读）；⚠ 警告列出
   生成失败/生成中的卡。
2. 剧本/分镜表/调研卡恒在（置顶锚点）；尾部「其余 N 个节点未列出」不代表
   没有——用 `canvas_query({query,types,status,resourceOnly})` 检索，
   不要猜 id。
3. status=error 的卡先 read_node 看 errorMessage 再决定重试；
   loading 中的卡不要重复触发生成。
4. read_node 返回：标题+正文全文、分镜表的行清单（含 rid，行级修改要用）、
   邻接连线（→ 出边 / ← 入边，带邻居卡摘要）。
5. 找出图参考 URL：`canvas_query({resourceOnly:true})` 返回带图/视频/音频
   卡的 ⟨图:URL⟩；摘要的节点行上也带媒体标记，两者同源。
6. 工具结果返回后以结果为准继续下一步，不要拿聊天历史里的旧画布状态当现状。

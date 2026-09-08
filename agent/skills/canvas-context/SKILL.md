---
name: canvas-context
description: 画布读写协议——摘要/版本与警告语义、canvas_query 检索与 read_node 读取、批量编辑的干跑与执行后核对、分镜行级回填；需要基于画布现状继续工作、找出图参考图或批量改卡时适用。
---

# 画布读写协议

摘要（「画布当前状态」）是索引不是全文，先读事实再动作：

1. 头部：节点/连线/选中计数、类型分布、版本 rN（乐观锁版本——与你上轮
   见过的数字不同说明用户或别处改过画布，写前重读）；⚠ 警告列出
   生成失败/生成中的卡。
2. 剧本/分镜表/调研卡恒在（置顶锚点），不因预算被裁；尾部「其余 N 个节点
   未列出」用 `canvas_query({query,types,status,resourceOnly})` 检索。
3. status=error 的卡先 read_node 看 errorMessage 再决定重试；
   loading 中的卡不要重复触发生成。
4. 找出图参考 URL：`canvas_query({resourceOnly:true})` 返回带图/视频/音频
   卡的 ⟨图:URL⟩；摘要的节点行上也带媒体标记，两者同源。

批量 / 破坏性编辑（改 10 张卡以上或含删除、分组时）：

5. 写前先读：摘要索引 → canvas_query 检索 → read_node 详情。
6. 复杂批量先用 canvas_validate_ops 干跑：issues 里 severity=error 的必须
   修正 ops 后重新干跑，全过再 canvas_ops 应用；warning（如行引用资产无
   同名卡）向用户说明后再决定。
7. 执行后核对：canvas_ops 结果里 errors 为空才算成功；连了新节点可用
   read_node 看邻接连线确认真实存在，不要凭「发过操作」就声称已连线。
8. 删除/分组会弹出审批卡等待用户确认——确认前不要重复发同类操作，
   被拒后如实停手并说明；部分成功要说明哪几项成了、哪几项没成。
9. 分镜行级修改（改某一行画面/回填行图）用 update_node 的
   `row:{rid,…}`，rid 从 read_node 返回的分镜行清单里取。
10. 需要带用户看结果时 set_viewport 定位到目标区域。

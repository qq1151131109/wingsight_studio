---
name: canvas-editing
description: 批量/破坏性画布编辑的可靠流程——干跑校验、占位符 id、执行后核对、失败如实报；改 10 张卡以上或含删除/分组时适用。
---

# 可靠画布编辑

- 写前先读：摘要索引 → canvas_query 检索 → read_node 详情。只用真实 id 或
  同批 add_node 的 id 占位符，绝不按 n_xxx 格式拼造节点 id。
- 复杂批量（≥10 项或含删除/分组/对新建节点连线）先用 canvas_validate_ops
  干跑：issues 里 severity=error 的必须修正 ops 后重新干跑，全过再
  canvas_ops 应用；warning（如行引用资产无同名卡）向用户说明后再决定。
- 执行后核对：canvas_ops 结果里 errors 为空才算成功；连了新节点可用
  read_node 看邻接连线确认真实存在，不要凭「发过操作」就声称已连线。
- 删除/分组会弹出审批卡等待用户确认——确认前不要重复发同类操作，
  被拒后如实停手并说明。
- 部分成功要说明哪几项成了、哪几项没成；计划里的失败步骤标失败，
  不标完成。
- 布局：批量建卡不指定 position 时系统自动错峰布局，不要把几十张卡全放
  同一点；需要带用户看结果时 set_viewport 定位到目标区域。
- 分镜行级修改（改某一行画面/回填行图）用 update_node 的
  `row:{rid,…}`，rid 从 read_node 返回的分镜行清单里取。

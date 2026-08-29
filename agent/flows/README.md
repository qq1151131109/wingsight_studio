# agent/flows — langflow 业务工作流（版本化源）

langflow 的 SQLite 是运行时存储；本目录是本项目全部业务 flow 的**导出源**，
跟代码一起版本管理。langflow 仓库（`~/Desktop/langflow`）是上游产品源码，
不放业务资产。

## 流程清单

| 文件 | flow 名 | 用途 | 环境变量 | tweaks 关键节点 |
|---|---|---|---|---|
| `asset-decompose.json` | 资产拆解 | 剧本/分镜稿 → 角色/场景/道具资产 JSON | `LANGFLOW_DECOMPOSE_FLOW_ID` | `LanguageModelComponent-nFbmO`（system_message） |
| `asset-imagegen.json` | 单资产出图 | 资产 JSON（tweaks 注入）→ 豆包出图 | `LANGFLOW_IMAGEGEN_FLOW_ID` | `BatchAssetSheet-img02`（assets_payload） |
| `promo-copy.json` | 宣发文案生成 | 飞书宣发资料 → 三路大模型并行 → 合并文案 | `LANGFLOW_SKILLS_JSON`（技能注册内含 flowId） | `PromptTemplate-Writer`（title/count/platform/batch_kind/brief/form） |
| `shotlist-generate.json` | 分镜表生成 | 剧本 → 分镜 rows（景别/运镜/时长/画面/台词） | `LANGFLOW_SHOTLIST_FLOW_ID` | 无（参数走 input_value 文本头注入） |

注：根 `.env.local` 里还有一个 `LANGFLOW_FLOW_ID`（fa971fe1…），指向的 flow
已从 langflow 删除，属历史遗留，待清理。

## 导出（langflow → 本目录）

```bash
source ../.env.local   # 取 LANGFLOW_API_KEY
./export.sh <flow_id> <文件名.json>
```

## 导入（本目录 → langflow，重建环境用）

```bash
source ../.env.local
curl -s --compressed -X POST http://localhost:7860/api/v1/flows/ \
  -H "Content-Type: application/json" -H "x-api-key: $LANGFLOW_API_KEY" \
  -d @shotlist-generate.json
# 返回体里的 id 即新 flow id，写回 .env.local 对应变量
```

## 约定

- 导出时剥除 `_frontend_node_flow_id` / `_frontend_node_folder_id` 两个前端
  元数据（export.sh 已处理），避免残留旧 flow 引用
- agent 经 **v1 阻塞 API**（`/api/v1/run/{flow_id}`）调用，参数用 tweaks 按
  **节点 id** 注入；Prompt 模板变量只收字符串（传 int 会 500）
- 修改 flow 后：先在 langflow UI 调试，再 `export.sh` 回写本目录，保持两处一致

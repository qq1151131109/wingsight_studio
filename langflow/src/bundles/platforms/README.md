# lfx-platforms — Wingsight 模型平台扩展包

把 wingsight 使用的 OpenAI 兼容模型平台（智谱 BigModel / DMX / DeepSeek…）注册为
langflow 的一等命名 provider：模型下拉按真实平台名分组、凭据表单/启用判定/live
模型拉取/静态目录全部由 manifest 驱动。

## 加新平台（不改代码）

1. `src/lfx_platforms/extension.json` 的 `providers[]` 加一条声明：
   `name`（provider 名，wingsight `agent/models.py` 的 provider 字段用它）、
   `provider_id`（小写 slug）、`metadata.variables`（`<前缀>_BASE_URL` +
   `<前缀>_API_KEY` 两变量）、`live_discovery`/`validator`/`catalog_loader` 点路径。
2. `src/lfx_platforms/discovery.py` 的 `_VARIABLE_PREFIXES`、`catalog.py` 的
   `_PLATFORM_MODELS` 各补一行（变量键派生 + 静态兜底模型）。
3. `uv pip install -e src/bundles/platforms`（setup-langflow.sh 自动做）→
   重启 langflow 生效。
4. `langflow/.env` 的 `LANGFLOW_SSRF_ALLOWED_HOSTS` 放行新平台域名。
5. langflow 里建好两个全局变量（setup 脚本从 `.env.local` 的
   `<前缀>_API_KEY` / `<前缀>_BASE_URL` 自动种子）。

## 运行时

wingsight 的 `text_model_tweaks()` 按**组件名**注 `{model_name, provider}`，
provider 值即这里的平台名；base_url/api_key 由 registry 通用路径从 langflow
全局变量解析（DB 优先、进程 env 回退）。

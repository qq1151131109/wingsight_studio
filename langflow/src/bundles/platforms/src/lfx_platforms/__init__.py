"""Wingsight 平台扩展包：把自有的 OpenAI 兼容模型平台注册为一等命名 provider。

加平台只改 `extension.json`（providers[] 加一条声明）+ 重启 langflow，
不改任何 Python 代码——元数据（变量表/mapping）、凭据表单、启用判定、
live 模型拉取、静态目录全部由 manifest 驱动。详见仓库内 bundles/README。
"""

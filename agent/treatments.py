"""讲法（treatment）注册表：选题的形态轴。

内容（讲什么）× 讲法（怎么讲）是选题的两条独立创意轴。讲法做成注册表
而非每次让 LLM 现编——一致性、可去重、质量可控（同 VERTICAL_SPECS 范式）；
LLM 的职责是「配对」（哪个讲法适配哪个方向）与「偶尔提议库外新讲法」。

archive_required = 六问第二问（素材基础）是否按具名档案/影像从严判：
  True：需要具名档案/影像/实物，冷门信号驱动（严肃档案系一族）
  False：大众熟知母题 + 原创设定即可（形态创新一族，如萌化、榜单体）
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

ARCHIVAL = "archival"  # 默认讲法：配对失败/不适配时的兜底


@dataclass(frozen=True)
class Treatment:
    id: str
    name: str
    mechanism: str  # 观众体验的核心装置（一句话说清怎么讲）
    reference: str  # 真实存在的对标
    fit_hint: str  # 适配什么题材、什么时候用
    archive_required: bool
    compliance_note: str  # 合规分支提示（「—」= 无特殊分支）
    use_count: int = 0  # 动态层：配对采用次数（热度浮沉依据；核心层恒 0）
    source: str = "core"  # core=手写经典层 / extracted=对标片提取 / proposal=模型提案


TREATMENTS: list[Treatment] = [
    Treatment(
        id="archival",
        name="严肃档案系",
        mechanism="档案影像+亲历足迹+CG复原，把一件事的来龙去脉讲透",
        reference="《河西走廊》",
        fit_hint="有具名档案/遗址/影像留痕的题材（管线的默认讲法）",
        archive_required=True,
        compliance_note="—",
    ),
    Treatment(
        id="moe_cats",
        name="萌化拟人",
        mechanism="历史角色全部萌化（猫/动物/食物），喜剧降低门槛，史实严格",
        reference="《假如历史是一群喵》",
        fit_hint="大众熟知的王朝/事件/常识史——观众「知道但没兴趣」的题",
        archive_required=False,
        compliance_note="战争苦难、灾害伤亡等沉重题材不适用；史实必须可查，防娱乐化失实",
    ),
    Treatment(
        id="object_voice",
        name="物品第一人称",
        mechanism="一件器物/文书当叙述者，用它的「一生」串起时代",
        reference="《如果国宝会说话》",
        fit_hint="有明星文物/文书/器物谱系的题（器物须具名可查）",
        archive_required=True,
        compliance_note="—",
    ),
    Treatment(
        id="countdown",
        name="进程倒计时",
        mechanism="全片按一个不可逆过程的倒计时推进（发射前72小时/王朝最后100天）",
        reference="《阿波罗11号》（Apollo 11）",
        fit_hint="有明确终点的时间敏感进程（工程/战争/政权倒台）",
        archive_required=True,
        compliance_note="—",
    ),
    Treatment(
        id="map_march",
        name="地图行军",
        mechanism="全程地图动画上推进一个空间过程（商路/战争/迁徙），箭头即叙事",
        reference="《伟大的卫国战争》",
        fit_hint="跨地域的空间性题材（路线/扩张/贸易网络）",
        archive_required=True,
        compliance_note="—",
    ),
    Treatment(
        id="cold_case",
        name="悬案重审",
        mechanism="按侦查/司法程序重开一桩历史悬案，证据链即悬念",
        reference="《制造杀人犯》（Making a Murderer）",
        fit_hint="有档案可查的悬案/争议定性/翻案史",
        archive_required=True,
        compliance_note="未定性争议不得单方定案（六问第六问从严）",
    ),
    Treatment(
        id="craft_rebuild",
        name="逆向复原",
        mechanism="今人按古法手工复原一个器物/工艺，实操过程即叙事",
        reference="《我在故宫修文物》",
        fit_hint="有可复原实物的工艺/技术史（工艺须可考据）",
        archive_required=True,
        compliance_note="—",
    ),
    Treatment(
        id="civilisations",
        name="双线对照",
        mechanism="同一时代两条线平行推进，每集一次交汇对照（东方/西方、对手双方）",
        reference="《文明》（Civilisations, BBC）",
        fit_hint="有跨文明/跨地域平行样本的题材",
        archive_required=True,
        compliance_note="—",
    ),
    Treatment(
        id="small_person",
        name="小人物折射",
        mechanism="跟拍一个素人/一个家庭，用他的具体生活折射大时代命题",
        reference="《四个春天》",
        fit_hint="有当下活的拍摄对象、大命题小切口的题",
        archive_required=False,
        compliance_note="依赖真人出镜授权（AIGC 管线需评估情景再现替代）",
    ),
    Treatment(
        id="daily_hook",
        name="日常物件钩子",
        mechanism="从一件今天人人可碰的日常物出发，钩出一门冷学问的历史纵深",
        reference="《舌尖上的中国》",
        fit_hint="学问线扎实但题材本身枯燥的题（盐/邮票/红绿灯）",
        archive_required=False,
        compliance_note="—",
    ),
    Treatment(
        id="money_lens",
        name="账本视角",
        mechanism="把宏大命题换算成钱/时间/能量的账本，一笔账讲一个时代",
        reference="《美国商业大亨传奇》（The Men Who Built America）",
        fit_hint="有财政/贸易/成本数据可考的经济史、产业史",
        archive_required=True,
        compliance_note="—",
    ),
    Treatment(
        id="listicle",
        name="榜单体",
        mechanism="N 个同类单元按一个反直觉标准排布，每集一个独立故事",
        reference="B站知识区榜单打法",
        fit_hint="单元丰富的集合型母题（观众可先看单集）",
        archive_required=False,
        compliance_note="—",
    ),
]

_BY_ID = {t.id: t for t in TREATMENTS}

# 动态层进 payload 的条数上限（控制配对 flow 提示词长度；核心层全量常驻）
DYNAMIC_PAYLOAD_LIMIT = 12


def _conn():
    import topics  # 运行期晚导入：topics 是存储叶模块，无环

    return topics._conn()


def _now() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat()


def ensure_table() -> None:
    import topics

    topics.init_topics_db()


def treatment_by_id(tid: str) -> Treatment | None:
    t = _BY_ID.get(str(tid or "").strip())
    if t is not None:
        return t
    try:
        with _conn() as conn:
            row = conn.execute(
                "SELECT * FROM treatments WHERE id = ?", (str(tid or "").strip(),)
            ).fetchone()
    except Exception:
        return None
    if row is None:
        return None
    return Treatment(
        id=row["id"],
        name=row["name"],
        mechanism=row["mechanism"],
        reference=row["reference"],
        fit_hint=row["fit_hint"],
        archive_required=bool(row["archive_required"]),
        compliance_note=row["compliance_note"],
        use_count=int(row["use_count"]),
        source=row["source"],
    )


def record_use(tid: str) -> None:
    """配对采用计数（动态层热度来源；核心层不在表内，忽略）。"""
    try:
        with _conn() as conn:
            conn.execute(
                "UPDATE treatments SET use_count = use_count + 1, last_used = ? WHERE id = ?",
                (_now(), str(tid or "").strip()),
            )
    except Exception:
        pass  # 热度记账失败不影响主流程


def upsert_dynamic(entry: dict[str, Any], source: str) -> bool:
    """动态层入库（extracted=对标片提取 / proposal=配对模型提案）。同 id 更新机制等字段。"""
    tid = str(entry.get("id") or "").strip()
    name = str(entry.get("name") or "").strip()
    mechanism = str(entry.get("mechanism") or "").strip()
    if not tid or not name or not mechanism:
        return False
    try:
        with _conn() as conn:
            conn.execute(
                "INSERT INTO treatments (id, name, mechanism, reference, fit_hint,"
                " archive_required, compliance_note, source, created_at)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
                " ON CONFLICT(id) DO UPDATE SET name = excluded.name, mechanism = excluded.mechanism",
                (
                    tid,
                    name[:40],
                    mechanism[:200],
                    str(entry.get("reference") or "").strip()[:80],
                    str(entry.get("fit") or entry.get("fit_hint") or "").strip()[:120],
                    1 if entry.get("archive_required") else 0,
                    str(entry.get("compliance_note") or "").strip()[:120],
                    source,
                    _now(),
                ),
            )
        return True
    except Exception:
        return False


def dynamic_treatments(limit: int = DYNAMIC_PAYLOAD_LIMIT) -> list[Treatment]:
    """动态层按使用热度（其次新旧）取头部条目；零使用长期不用的自然沉底。"""
    try:
        with _conn() as conn:
            rows = conn.execute(
                "SELECT * FROM treatments ORDER BY use_count DESC, last_used DESC,"
                " created_at DESC LIMIT ?",
                (limit,),
            ).fetchall()
    except Exception:
        return []
    return [
        Treatment(
            id=r["id"],
            name=r["name"],
            mechanism=r["mechanism"],
            reference=r["reference"],
            fit_hint=r["fit_hint"],
            archive_required=bool(r["archive_required"]),
            compliance_note=r["compliance_note"],
            use_count=int(r["use_count"]),
            source=r["source"],
        )
        for r in rows
    ]


def treatments_payload(limit_dynamic: int = DYNAMIC_PAYLOAD_LIMIT) -> list[dict[str, Any]]:
    """喂给讲法配对 flow 的库形态：核心层全量 + 动态层热度头部。"""
    out = [
        {"id": t.id, "name": t.name, "mechanism": t.mechanism, "fit": t.fit_hint, "ref": t.reference}
        for t in TREATMENTS
    ]
    out.extend(
        {"id": t.id, "name": t.name, "mechanism": t.mechanism, "fit": t.fit_hint, "ref": t.reference}
        for t in dynamic_treatments(limit_dynamic)
    )
    return out


def treatment_card_shape(tid: str, why: str, alternates: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    """落卡形态：注册表补全名称/机制，配对结果附观众侧理由与备选。"""
    t = treatment_by_id(tid)
    if t is None:
        return {}
    return {
        "id": t.id,
        "name": t.name,
        "mechanism": t.mechanism,
        "why": str(why or "").strip()[:120],
        "alternates": [
            {"id": a.get("id"), "name": treatment_by_id(str(a.get("id"))).name if treatment_by_id(str(a.get("id"))) else "", "why": str(a.get("why") or "").strip()[:120]}
            for a in (alternates or [])[:2]
            if treatment_by_id(str(a.get("id") or ""))
        ],
    }

"""选题池双层管线：生料批量生成（常规刷新）+ 按需深挖（导演点名）。

**生料层（量大、便宜、创意优先）**：六源语料（材料种子/周年/已验证内容/
对标片单/知乎高赞/维基类别语料）洗牌混垂类 → 分批喂批量生成 flow →
产片名式选题（标题/情绪钩子/原型出处/垂类/索引标签）以 stage=raw 落库。
每批一次 LLM 调用、零检索成本，单轮上限 IDEATE_BATCHES_CAP 批。

**已深挖层（贵、按需、证据驱动）**：导演对某条感兴趣点"深挖"→
deep_dive_one 跑完整取证管线（规划查询 → 并行检索 → 追查 → 市场实查 →
角度生成 → verdict 两级结论）→ 证据足升级为建议卡（stage=verified），
证据薄记入信源底账、卡仍是生料。观察卡复查（rescan）沿用原机制在刷新
尾部小预算轮转，只扫已深挖的薄卡。

与 juben 的差异：LLM 调用点全部走 Langflow flow（v1 阻塞 API，参数经
input_value 文本载荷注入），本模块只做编排、检索执行与 JSON 解析。
指纹幂等保持在落库前：同题（含已认领/已忽略）不重复入库。
外部依赖（flow 调用 / 搜索 / 仓储）全部经构造参数注入，测试注 fake。
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import random
import uuid
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from typing import Any, Awaitable, Callable

import topics as store

logger = logging.getLogger(__name__)

# 垂类注册表：加垂类=加一条 spec（标签/边界/专属材料种子/色 token），零代码改动。
# 垂类清单随研判载荷下发，flow prompt 不写死垂类。不同垂类信源结构不同：
# history/crime 靠材料事件种子，humanity 的主信源是已验证内容流（特稿/播客），
# science 靠机构发布与论文报道——material_seeds 为空的垂类由跨垂类源供给。
@dataclass(frozen=True)
class VerticalSpec:
    id: str
    label: str
    color: str  # 前端色 token（垂类圆点）
    scope: str  # 一句话边界，进研判载荷供垂类裁决
    material_seeds: tuple[str, ...] = ()


VERTICAL_SPECS: dict[str, VerticalSpec] = {
    "history": VerticalSpec(
        id="history", label="历史", color="var(--color-cool)",
        scope="历史事件、历史人物、考古发现、文物、时代记忆（核心驱动是过去的事件与过去的人）",
        material_seeds=(
            "考古中国 发布会 {year}",
            "考古新发现 {year}",
            "出土简牍 整理公布 {year}",
            "历史档案 解密公开 {year}",
        ),
    ),
    "crime": VerticalSpec(
        id="crime", label="罪案", color="var(--color-danger)",
        scope="真实刑事案件、悬案旧案、司法与社会安全事件（核心驱动是案件与正义）",
        material_seeds=(
            "最高人民法院 典型案例 {year}",
            "再审改判 案件 {year}",
            "判决文书 公开 案件 {year}",
            "案件档案 解密 {year}",
        ),
    ),
    "humanity": VerticalSpec(
        id="humanity", label="人文", color="var(--color-warm)",
        scope="普通人的命运与当下社会生活：职业、教育、家庭、迁徙、口述记忆（核心驱动是当下的生活；特稿与叙事播客是主信源）",
    ),
    "science": VerticalSpec(
        id="science", label="科普", color="var(--color-good)",
        scope="自然科学新发现、技术进展、科学机构发布（核心驱动是世界的规律，人物服务于认知）",
        material_seeds=(
            "科学 重大发现 {year}",
            "中国科学院 重大成果 发布 {year}",
        ),
    ),
    "food": VerticalSpec(
        id="food", label="美食", color="var(--color-warm)",
        scope="饮食文化：菜系、小吃、茶酒、食材与味觉记忆（核心驱动是味道背后的人与地方）",
        material_seeds=(
            "美食纪录片 出圈 {year}",
            "地方菜系 非遗 技艺 {year}",
            "老字号 兴衰 {year}",
            "食材 起源 考据",
        ),
    ),
    "nature": VerticalSpec(
        id="nature", label="自然", color="var(--color-good)",
        scope="自然生态、野生动物、荒野地理与气候（核心驱动是生命与地球；风格化科普影像，不做伪实拍）",
        material_seeds=(
            "野生动物 保护 突破 {year}",
            "生态修复 成果 {year}",
            "自然保护地 新设立 {year}",
            "物种 新发现 {year}",
        ),
    ),
    "music": VerticalSpec(
        id="music", label="音乐艺术", color="var(--color-cool)",
        scope="音乐、美术、戏曲、设计与艺术家命运（核心驱动是作品与创作者）",
        material_seeds=(
            "音乐纪录片 出圈 {year}",
            "艺术家 回顾展 {year}",
            "非遗传承人 技艺 {year}",
            "戏曲剧种 保护 {year}",
        ),
    ),
    "finance": VerticalSpec(
        id="finance", label="财经", color="var(--color-cool)",
        scope="商业史、公司兴衰、资本事件与经济变迁（核心驱动是钱与人的决策）",
        material_seeds=(
            "商业史 案例 复盘 {year}",
            "公司 兴衰 破产 {year}",
            "经济数据 发布 解读 {year}",
            "老品牌 消失 调查 {year}",
        ),
    ),
    "travel": VerticalSpec(
        id="travel", label="旅行地理", color="var(--color-warm)",
        scope="地理、路线、行走与地方志（核心驱动是空间与在地的故事）",
        material_seeds=(
            "地理发现 考察 {year}",
            "古道 路线 考证 {year}",
            "目的地 走红 调查 {year}",
        ),
    ),
    "kids": VerticalSpec(
        id="kids", label="儿童教育", color="var(--color-warm)",
        scope="儿童视角、科普启蒙与教育议题（核心驱动是成长与认知；动画/科普形态）",
        material_seeds=(
            "儿童 科普 出圈 {year}",
            "教育 议题 纪录 {year}",
            "青少年 成长 记录 {year}",
        ),
    ),
    "military": VerticalSpec(
        id="military", label="军事战争", color="var(--color-danger)",
        scope="战争史、战役、军人记忆与国防科技（核心驱动是档案与人的命运；档案修复+解说形态）",
        material_seeds=(
            "战争档案 解密 公开 {year}",
            "战役 纪念 新考证 {year}",
            "老兵 口述 抢救 {year}",
            "军工 记忆 公开 {year}",
        ),
    ),
}
VERTICALS: tuple[str, ...] = tuple(VERTICAL_SPECS)
VERTICAL_LABELS: dict[str, str] = {k: v.label for k, v in VERTICAL_SPECS.items()}

# --- 种子矩阵：主题词 × 角度 展开成大规模搜索种子（语料放量的主杠杆） ---
# 每垂类 15-20 个有纪实含金量的主题词（具名人物/事件/地域/物种）× 通用角度，
# 组合出几百个种子；每轮按轮转游标取样 SEEDS_PER_RUN_CAP 条，跨轮覆盖全集。
SEED_MATRIX: dict[str, tuple[list[str], tuple[str, ...]]] = {
    "history": (
        ["秦始皇", "汉武帝", "武则天", "成吉思汗", "康熙帝", "郑和", "玄奘", "张骞", "苏东坡", "王安石",
         "岳飞", "李清照", "郑成功", "林则徐", "三星堆", "敦煌莫高窟", "兵马俑", "大运河", "长城", "丝绸之路"],
        ("考古新发现", "未解之谜", "文物传奇", "档案解密", "最新研究"),
    ),
    "crime": (
        ["白银连环杀人案", "南大碎尸案", "呼格吉勒图案", "聂树斌案", "张玉环案", "劳荣枝案", "白宝山案", "佟励刚案",
         "悍匪周克华", "跨国电信诈骗", "湄公河大案", "灭门悬案", "越狱追捕", "贪官外逃", "缉毒卧底", "法医手记"],
        ("告破细节", "悬案重启", "真凶落网", "冤案平反", "侦破技术"),
    ),
    "humanity": (
        ["外卖骑手", "农民工", "乡村教师", "大山里的女孩", "留守儿童", "高龄农民工", "北漂", "县城青年",
         "罕见病家庭", "临终关怀", "殡葬师", "残障人就业", "代驾司机", "夜班护士", "乡村医生", "独立书店"],
        ("人生切片", "命运转折", "田野调查", "口述实录", "生存现状"),
    ),
    "science": (
        ["嫦娥探月", "天问火星", "中国天眼", "量子计算", "深海勇士", "人造太阳", "脑机接口", "北斗导航",
         "中国空间站", "基因编辑", "可控核聚变", "冰川消融", "恐龙化石", "古DNA", "大科学装置"],
        ("攻关历程", "重大突破", "幕后团队", "未解难题", "最新成果"),
    ),
    "food": (
        ["川菜", "粤菜", "鲁菜", "淮扬菜", "陕西面食", "兰州牛肉面", "火锅", "烧烤", "早点铺", "夜市小吃",
         "茶叶", "白酒酿造", "酱油酿造", "豆腐", "火腿", "宫廷菜"],
        ("技艺传承", "老字号兴衰", "风土溯源", "匠人故事", "出圈现象"),
    ),
    "nature": (
        ["大熊猫", "雪豹", "滇金丝猴", "朱鹮", "藏羚羊", "长江江豚", "候鸟迁徙", "珊瑚礁", "青藏高原",
         "三江源", "红树林", "普氏野马", "东北虎", "亚洲象北迁", "可可西里", "深海生物"],
        ("保护历程", "重返野外", "栖息地揭秘", "追踪记录", "濒危反转"),
    ),
    "music": (
        ["摇滚乐队", "民谣歌手", "戏曲名角", "交响乐团", "民族乐器", "说唱厂牌", "古琴", "钢琴家",
         "美声歌唱家", "DJ 电子乐", "民歌声腔", "音乐节"],
        ("生存现状", "爆红背后", "传承人故事", "江湖往事", "时代记忆"),
    ),
    "finance": (
        ["老字号", "上市公司暴雷", "县级财政", "义乌小商品", "深圳制造", "温州商人", "晋商票号", "房地产周期",
         "直播电商", "新能源车企", "芯片产业", "县城生意"],
        ("兴衰复盘", "暴雷调查", "财富故事", "产业迁徙", "生死线"),
    ),
    "travel": (
        ["茶马古道", "丝绸之路沿线", "黄河沿线", "长江沿线", "大运河沿线", "边境小城", "沙漠绿洲", "火山岛",
         "徽州古村", "川西线", "国道318"],
        ("路线重走", "在地故事", "消失中的风景", "冷门目的地", "地方志"),
    ),
    "kids": (
        ["乡村幼儿园", "特殊儿童", "儿童科普", "少年体校", "玩具设计", "儿童读物", "儿童医院成长记"],
        ("成长记录", "启蒙方式", "教育实验", "天才与困境"),
    ),
    "military": (
        ["两弹一星", "航母建造", "抗战老兵", "志愿军工兵", "三线军工厂", "边境反击战", "导弹试验", "大阅兵背后",
         "军马场", "功勋飞机", "潜艇部队", "边防哨所"],
        ("档案解密", "老兵口述", "工程幕后", "首次公开", "历史还原"),
    ),
}
# 每轮取样的种子条数上限（≈160 次搜索请求，10 结果/条 → ~1600 语料信号）
SEEDS_PER_RUN_CAP = 160
_SEED_ROTATE_KEY = "topic_pool_seed_rotate"


def verticals_payload() -> list[dict[str, str]]:
    """垂类清单（进研判载荷与前端下发，prompt 不写死垂类）。"""
    return [{"id": v.id, "label": v.label, "scope": v.scope, "color": v.color} for v in VERTICAL_SPECS.values()]

# --- 生料选题层（批量创意生成）：池子的常规刷新只跑这一层，量大、便宜 ---
# 单批喂给生成 flow 的语料条数（约 1 次长上下文调用产 8-12 个选题；批越大
# 模型输出越长，实测 70 条语料产 30 题会超 agent 侧 300s 超时——别调回去）
# 两步生成的批参数：先发散（线索→方向清单，不筛选），再收敛（方向→过闸成片卡）。
# 每步的输出都受 agent 侧 300s 超时约束（实测单次输出 ~30 个 JSON 对象会超时，
# 别把任何一步的期望输出量调回去）
DIVERGE_CLUES_PER_BATCH = 5  # 发散批：5 线索 × 6-10 方向 ≈ 2k token 输出，安全
CONVERGE_DIRECTIONS_PER_BATCH = 24  # 收敛批：24 方向过三问闸，过闸率天然 <1，输出 8-16 题
CONVERGE_ENTRIES_CAP = 20  # 单个收敛批的落卡上限（flow 违规刷屏时掐断）
# 单轮刷新的发散调用上限（成本硬上界：≤16 次发散 + 各 ~2 次收敛）
IDEATE_BATCHES_CAP = 16
# 组题（集合型题眼 → 检索收集候选单元 → 选集卡）单轮名额：每次组题 =
# 1 次查询规划 + 2-3 条检索 + 1 次合成，帽住检索成本
SERIES_ASSEMBLE_CAP = 6
# 组题成功的最少候选单元数：凑不够不成卡（不做单片降级，明记 missed）
SERIES_MIN_UNITS = 3
# 当日已喂语料指纹的落账键与上限（同日多轮刷新各喂新料；次日自动换日重置）
IDEATE_SEEN_KEY = "topic_pool_ideate_seen"
# 当日语料缓存键（采集结果落账，服务重启后凭缓存续跑剩余批次，不重新采集）
IDEATE_CORPUS_KEY = "topic_pool_ideate_corpus"
# 六源采集的通道级散账（每通道完成即落账，重启只补缺失通道）
CORPUS_PARTIALS_KEY = "topic_pool_corpus_partials"
IDEATE_SEEN_CAP = 4000

# 已深挖层（导演点名才跑）：取证/verdict/市场实查的全流程，见 deep_dive_one。
# 观察卡复查：每轮刷新尾部顺带取最久未扫的几张薄卡做缺口导向小预算复查。
RESCAN_BATCH_SIZE = 3
RESCAN_PLAN_MAX_QUERIES = 3
RESCAN_FOLLOWUP_MAX_QUERIES = 2
# 同一张卡两次复查的最小间隔（含建卡到首次复查的冷却）；手动深挖不受限
RESCAN_COOLDOWN_HOURS = 24.0
# 每条查询的检索结果条数上限
RESEARCH_RESULTS_CAP = 5
# 迭代调研的步数帽：首批 ≤4 查 + 追查 ≤3 查，成本有硬上界
RESEARCH_PLAN_MAX_QUERIES = 4
RESEARCH_FOLLOWUP_MAX_QUERIES = 3
# 每条材料种子查询接受的条目上限
MAX_ITEMS_PER_QUERY = 10
# 可拍单元类型：建议卡必须收成其一，归不出说明单元不清（降为观察卡）
UNIT_KINDS: tuple[str, ...] = ("person", "object", "case", "era")
# 体量形态；series 必须带串珠问题（series_thread），缺了诚实地按 single
SCALES: tuple[str, ...] = ("single", "series", "anthology")

# 已验证内容种子：特稿媒体（谷雨/极昼/人物等）的每篇报道都是"编辑部+
# 田野"双重把关过的人物选题，故事性已验证——管线判断纪录片化增量。
# 微信公众号无公开 RSS，走澎湃/腾讯新闻的分发镜像（通道实测可达）。
VALIDATED_SEED_QUERIES: tuple[str, ...] = (
    "极昼工作室 报道 {year}",
    "谷雨实验室 特稿 {year}",
    "人物杂志 报道 {year}",
    "人间 theLivings 故事 {year}",
)
# 对标片单种子：节展/海外已验证题材 → 国产化空白（名单页一条信号含多部
# 影片，研判负责拆解评估）。
BENCHMARK_SEED_QUERIES: tuple[str, ...] = (
    "IDFA 获奖纪录片 {year}",
    "圣丹斯 纪录片 获奖 {year}",
    "奥斯卡 最佳纪录片 提名 {year}",
    "BBC Storyville 纪录片 {year}",
)
# 周年窗口天数（提前量给调研与立项留时间；juben 同款 45-60 天取下沿）
ANNIVERSARY_WINDOW_DAYS = 45

# 同题市场实查（TikHub）：只属于已深挖层（导演点名后的取证流程），常规刷新
# 不再触碰。B站=纪录片存量+播放数、抖音=短视频消费侧（点赞为热度）、西瓜=
# 长片完整版存量、知乎=同题文章与赞同数（受众兴趣实证）。每簇取证只查一次
# 四平台并发各 5 条（按请求计费）。未配 TIKHUB_API_KEY 时探针为 None 照旧。
MARKET_PROBE_PLATFORMS: tuple[str, ...] = ("bilibili", "douyin", "xigua", "zhihu")
MARKET_PROBE_COUNT = 5
MARKET_PROBE_LABELS: dict[str, str] = {"bilibili": "B站", "douyin": "抖音", "xigua": "西瓜", "zhihu": "知乎"}
# 知乎热榜（讨论热度信号）每次刷新取的条数——已从信号源降级（泛娱乐占比高、
# 快照不稳定），保留方法但默认不进采集矩阵
ZHIHU_HOT_LIMIT = 15
# 知乎沉淀讨论种子：按垂类搜高赞文章/回答——赞同数是"公众已验证兴趣"的
# 沉淀性证据（不追热榜快照，追长期被搜索、被赞同的内容）
ZHIHU_DISCUSSION_SEEDS: dict[str, tuple[str, ...]] = {
    "history": ("近代史 考据", "考古 解读", "历史 冷知识"),
    "crime": ("悬案 真相", "冤案 平反", "刑侦 细节"),
    "humanity": ("普通人的故事", "小城 生活", "职业 真实经历"),
    "science": ("科普 颠覆认知", "宇宙 未解之谜", "人体 冷知识"),
    "food": ("美食 纪录", "地方小吃", "中华料理"),
    "nature": ("动物 纪录片", "野生动物 保护", "自然 奇观"),
    "music": ("音乐 纪录片", "乐队 故事", "民族音乐"),
    "finance": ("商业史", "公司 兴衰", "经济 冷知识"),
    "travel": ("旅行 纪录片", "小城 旅行", "地理 冷知识"),
    "military": ("战争 史", "军事 历史", "老兵 故事"),
}
# 高赞阈值：低于此赞同数的条目不算"已验证兴趣"（噪声多）
ZHIHU_MIN_VOTES = 100

FLOW_IDS = {
    "diverge": "LANGFLOW_TOPIC_DIVERGE_FLOW_ID",
    "ideate": "LANGFLOW_TOPIC_IDEATE_FLOW_ID",
    "series_compose": "LANGFLOW_TOPIC_SERIES_COMPOSE_FLOW_ID",
    "triage": "LANGFLOW_TOPIC_TRIAGE_FLOW_ID",
    "plan": "LANGFLOW_TOPIC_PLAN_FLOW_ID",
    "followup": "LANGFLOW_TOPIC_FOLLOWUP_FLOW_ID",
    "verdict": "LANGFLOW_TOPIC_VERDICT_FLOW_ID",
    "rescan_plan": "LANGFLOW_TOPIC_RESCAN_PLAN_FLOW_ID",
    "angle": "LANGFLOW_TOPIC_ANGLE_FLOW_ID",
}

import entities as entity_store
from entities import ENTITY_KINDS

# 角度生成器：取证后按爆款角度模板生成候选方案（一件物/一个人/一个场域/
# 过程叙事/档案考古/正义回归/悬念追查/时代切片），verdict 对照证据择优成卡。
# 未配置 flow 时跳过（verdict 按证据自选角度），不拦主刷新。
ANGLE_OPTIONS_CAP = 3


def fingerprint_of(title: str) -> str:
    """规范化标题的 sha256，作为池内幂等去重键。"""
    keep = [ch for ch in title.lower() if ch.isalnum()]
    return hashlib.sha256("".join(keep).encode("utf-8")).hexdigest()


def _year_anchor() -> str:
    """种子年份锚：查询词拼上当年年份，避免同一批旧结果反复命中。"""
    return str(date.today().year)


FlowRunner = Callable[[str, str], Awaitable[str]]
SearchFn = Callable[[str], Awaitable[dict[str, Any]]]
# 市场探针：主题词 → 研究日志形态的同题实查条目（label/query/results）
MarketProbeFn = Callable[[str], Awaitable[list[dict[str, Any]]]]


def _fmt_count(value: int | None) -> str:
    """计数格式化：12345 → '1.2万'；None → '—'。"""
    if value is None or value <= 0:
        return "—"
    if value >= 10_000:
        return f"{value / 10_000:.1f}万"
    return str(value)


def _format_market_item(item: dict[str, Any]) -> str:
    parts: list[str] = []
    if item.get("play_count"):
        parts.append(f"播放 {_fmt_count(item['play_count'])}")
    if item.get("like_count"):
        parts.append(f"点赞 {_fmt_count(item['like_count'])}")
    if item.get("author"):
        parts.append(str(item["author"]))
    if item.get("published_at"):
        parts.append(str(item["published_at"]))
    text = " · ".join(parts)
    if item.get("excerpt"):
        text = f"{text}｜{item['excerpt']}" if text else str(item["excerpt"])
    return text


def build_market_probe() -> MarketProbeFn | None:
    """按环境构造同题市场探针；未配 TIKHUB_API_KEY 返回 None（管线照旧）。"""
    api_key = os.environ.get("TIKHUB_API_KEY", "").strip()
    if not api_key:
        return None
    import tikhub

    client = tikhub.TikHubClient(
        api_key=api_key,
        base_url=os.environ.get("TIKHUB_BASE_URL", "").strip() or tikhub.DEFAULT_TIKHUB_BASE_URL,
    )

    async def probe(keyword: str) -> list[dict[str, Any]]:
        outcomes = await asyncio.gather(
            *(client.search_videos(p, keyword, count=MARKET_PROBE_COUNT) for p in MARKET_PROBE_PLATFORMS),
            return_exceptions=True,
        )
        entries: list[dict[str, Any]] = []
        for platform, outcome in zip(MARKET_PROBE_PLATFORMS, outcomes):
            if isinstance(outcome, BaseException):
                logger.warning("同题市场实查失败 platform=%s keyword=%s: %s", platform, keyword[:40], str(outcome)[:150])
                continue
            entries.append(
                {
                    "label": f"同题实查:{MARKET_PROBE_LABELS[platform]}",
                    "query": keyword,
                    "results": [
                        {"title": str(it.get("title") or ""), "url": str(it.get("url") or ""), "snippet": _format_market_item(it)}
                        for it in outcome
                        if str(it.get("title") or "").strip()
                    ],
                }
            )
        return entries

    return probe


@dataclass
class TriagePick:
    """研判短名单的一项：一个主题簇及其价值判断。"""

    members: list[dict[str, Any]]
    member_fingerprints: list[str]
    vertical: str
    theme: str
    reason: str
    arc: str = ""  # 生料卡的成片方案（题眼/素材/呈现/弧线），深挖取证与结论要核对它

    @property
    def primary_fingerprint(self) -> str:
        return self.member_fingerprints[0]


@dataclass
class IdeateResult:
    """单轮生料刷新的外部可观测结果（落 lastRun 给前端展示）。"""

    collected: int = 0  # 本轮待发散线索条数（五源信号 + 维基语料，扣当日已喂）
    directions: int = 0  # 本轮发散出的方向总数（含上轮中断遗留的待收敛方向）
    batches: int = 0  # 实际跑的发散调用次数
    created: int = 0  # 新落库的生料选题张数
    series_created: int = 0  # 组题成功的选集卡张数（计入 created）
    series_missed: int = 0  # 组题失败/候选不足/超名额的次数（明记不做单片降级）
    duplicates: int = 0  # 指纹去重跳过的条数
    rejected: int = 0  # 未过成立性闸被拒的条数（无 arc 成片推演 = 新闻稿式选题）
    error: str = ""


@dataclass
class RescanSummary:
    """一轮观察卡复查的外部可观测结果。"""

    rescanned: int = 0  # 实际复查张数（含证据仍薄与结论失败的）
    upgraded: int = 0  # 证据变硬升级为建议卡的张数


class TopicCurator:
    """策展编排器：材料窗口采集 → flow 研判 → 逐项取证 → flow 结论 → 落库。"""

    def __init__(
        self,
        flow_runner: FlowRunner | None = None,
        search: SearchFn | None = None,
        market_probe: MarketProbeFn | None = None,
    ) -> None:
        # 默认接线：LLM 走 langflow 阻塞调用，检索走文本级联（懒导入，测试注 fake 不触发）；
        # 市场探针未显式注入且配了 key 时才构建（无 key 即 None，实查整段跳过）
        if flow_runner is None:
            import skills

            flow_runner = skills.run_flow_blocking
        if search is None:
            from websearch import web_search

            search = web_search
        if market_probe is None:
            market_probe = build_market_probe()
        self.flow_runner = flow_runner
        self.search = search
        self.market_probe = market_probe

    # --- flow 调用 -----------------------------------------------------------

    def _flow_id(self, key: str) -> str:
        flow_id = os.environ.get(FLOW_IDS[key], "").strip()
        if not flow_id:
            raise RuntimeError(f"未配置 {FLOW_IDS[key]}（选题 {key} flow）")
        return flow_id

    async def _call_flow(self, key: str, payload: dict[str, Any]) -> Any:
        """跑一个选题 flow 并宽容解析 JSON 输出。

        解析失败（LLM 输出坏 JSON，非确定性）原样重试一次再抛；flow 调用
        本身失败（配置/引擎问题，确定性）不重试直接抛。实测曾有 40% 的
        入围线索因单次坏输出被整条丢弃。
        """
        assert self.flow_runner is not None
        # 全链统一目录默认文本模型（选题 flows 出厂是 glm-5.3-flash，勿依赖）；
        # 键 LanguageModelComponent 由 run_flow_blocking 前缀解析成真实节点 id
        from models import DEFAULT_TEXT_MODEL_ID, text_model_tweaks

        tweaks = {"LanguageModelComponent": text_model_tweaks(DEFAULT_TEXT_MODEL_ID)}
        last_error: ValueError | None = None
        for attempt in (1, 2):
            text = await self.flow_runner(
                self._flow_id(key), json.dumps(payload, ensure_ascii=False), tweaks=tweaks
            )
            if text.startswith("（"):
                # skills.run_flow_blocking 的错误以全角括号包裹；正常 LLM 输出不会
                raise RuntimeError(f"选题 {key} flow 调用失败: {text[:200]}")
            try:
                return extract_json(text)
            except ValueError as exc:
                last_error = exc
                logger.warning("选题 %s flow 输出解析失败（第 %d 次）: %s", key, attempt, str(exc)[:200])
        raise RuntimeError(f"选题 {key} flow 输出两次解析失败: {last_error}")

    # --- 采集：五源信号矩阵（材料事件 / 周年 / 已验证内容 / 对标片单） ---------

    async def collect_material_window(self) -> list[dict[str, Any]]:
        """材料事件采集（信号类型 material）：注册表种子 + 种子矩阵轮转取样。"""
        seeds: dict[str, list[str]] = {
            vid: list(q.format(year=_year_anchor()) for q in spec.material_seeds)
            for vid, spec in VERTICAL_SPECS.items()
            if spec.material_seeds
        }
        # 种子矩阵轮转取样：主题词×角度的几百个种子，每轮取一段新组合
        # （游标存 app_settings，跨轮推进；组合全集耗尽后回绕，指纹去重兜底）
        matrix: list[tuple[str, str]] = []
        for vid, (terms, angles) in SEED_MATRIX.items():
            for term in terms:
                for angle in angles:
                    matrix.append((vid, f"{term} {angle}"))
        cursor = int(store.get_setting(_SEED_ROTATE_KEY) or 0) % max(len(matrix), 1)
        picked = [matrix[(cursor + i) % len(matrix)] for i in range(min(SEEDS_PER_RUN_CAP, len(matrix)))]
        store.set_setting(_SEED_ROTATE_KEY, str((cursor + len(picked)) % max(len(matrix), 1)))
        for vid, query in picked:
            seeds.setdefault(vid, []).append(query.format(year=_year_anchor()) if "{year}" in query else query)
        flattened = {vid: tuple(queries) for vid, queries in seeds.items()}
        return await self._collect_seed_queries(flattened, signal_type="material")

    async def _collect_seed_queries(
        self, seeds: dict[str | None, tuple[str, ...]], signal_type: str
    ) -> list[dict[str, Any]]:
        """按种子查询搜索并转信号条目；单条种子失败只跳过该条。"""
        if self.search is None:
            return []
        fetched_at = datetime.now(timezone.utc).isoformat()
        items: list[dict[str, Any]] = []
        for vertical, queries in seeds.items():
            for query in queries:
                try:
                    response = await self.search(query)
                except Exception as exc:  # noqa: BLE001 - 采集失败不中断策展
                    logger.warning("信号采集搜索失败 query=%s: %s", query, str(exc)[:200])
                    continue
                for result in response.get("results", [])[:MAX_ITEMS_PER_QUERY]:
                    title = str(result.get("title") or "").strip()
                    if not title:
                        continue
                    items.append(self._signal_of(title, result, source=f"种子:{query}", signal_type=signal_type, vertical_seed=vertical, fetched_at=fetched_at))
        return items

    def _signal_of(
        self,
        title: str,
        result: dict[str, Any],
        *,
        source: str,
        signal_type: str,
        vertical_seed: str | None,
        fetched_at: str,
        platform: str = "web",
        snippet: str = "",
    ) -> dict[str, Any]:
        return {
            "title": title,
            "platform": platform,
            "source": source,
            "url": result.get("url") or "",
            "provider": result.get("provider") or "",
            "vertical_seed": vertical_seed,
            "signal_type": signal_type,
            "snippet": (snippet or str(result.get("snippet") or "")).strip()[:160],
            "fetched_at": fetched_at,
        }

    async def collect_anniversaries(self) -> list[dict[str, Any]]:
        """周年信号（确定性时间信号，零 LLM）：维基大事记 → 逢五逢十 → 提前 45 天进池。

        窗口按起点日期缓存（同一天内多次刷新不重拉维基）。
        """
        import topics as settings_store
        import wikiday

        today = date.today()
        cache = wikiday.load_window_cache(settings_store.get_setting(wikiday.CACHE_KEY))
        events = cache.get("events") if cache and cache.get("start") == today.isoformat() else None
        if events is None:
            events = await wikiday.anniversary_window(start=today, days=ANNIVERSARY_WINDOW_DAYS)
            settings_store.set_setting(wikiday.CACHE_KEY, wikiday.build_window_cache(today, events))
        fetched_at = datetime.now(timezone.utc).isoformat()
        return [
            {
                "title": f"{e['text']}（{e['age']}周年，{e['date']}）",
                "platform": "calendar",
                "source": f"周年节点:{e['date']}",
                "url": "",
                "provider": "wikipedia",
                "vertical_seed": None,
                "signal_type": "anniversary",
                "snippet": f"{e['age']}周年节点：{e['text']}",
                "fetched_at": fetched_at,
            }
            for e in events
        ]

    async def collect_validated_content(self) -> list[dict[str, Any]]:
        """已验证内容信号：特稿镜像（搜索）+ 叙事播客（RSS），故事性已验证。"""
        items = await self._collect_seed_queries(
            {None: tuple(q.format(year=_year_anchor()) for q in VALIDATED_SEED_QUERIES)},
            signal_type="validated",
        )
        try:
            import podcastfeed

            episodes = await podcastfeed.fetch_all_feeds()
        except Exception as exc:  # noqa: BLE001 - 播客源失败不拖累特稿信号
            logger.warning("播客信号采集失败: %s", str(exc)[:200])
            episodes = []
        fetched_at = datetime.now(timezone.utc).isoformat()
        items.extend(
            self._signal_of(
                ep["title"],
                {"url": ep["url"], "snippet": ep["snippet"], "provider": "rss"},
                source=f"播客:{ep['feed']}",
                signal_type="validated",
                vertical_seed=None,
                fetched_at=fetched_at,
                platform="podcast",
            )
            for ep in episodes
        )
        return items

    async def collect_benchmarks(self) -> list[dict[str, Any]]:
        """对标片单信号：节展/海外已验证题材 → 国产化空白。"""
        return await self._collect_seed_queries(
            {None: tuple(q.format(year=_year_anchor()) for q in BENCHMARK_SEED_QUERIES)},
            signal_type="benchmark",
        )

    async def collect_zhihu_discussions(self) -> list[dict[str, Any]]:
        """知乎沉淀讨论信号：按垂类种子搜高赞文章/回答（TikHub，1 种子 1 请求）。

        赞同数 ≥ ZHIHU_MIN_VOTES 才算"公众已验证兴趣"——收的是长期沉淀的
        内容（谁在搜、什么被顶上去），不是热榜快照。归 validated：研判判断
        纪录片化增量，纯段子/复述无材料纵深的不入围。
        """
        api_key = os.environ.get("TIKHUB_API_KEY", "").strip()
        if not api_key:
            return []
        import tikhub

        client = tikhub.TikHubClient(
            api_key=api_key,
            base_url=os.environ.get("TIKHUB_BASE_URL", "").strip() or tikhub.DEFAULT_TIKHUB_BASE_URL,
        )
        fetched_at = datetime.now(timezone.utc).isoformat()
        signals: list[dict[str, Any]] = []
        for vertical, keywords in ZHIHU_DISCUSSION_SEEDS.items():
            for keyword in keywords:
                try:
                    articles = await client.search_videos("zhihu", keyword, count=10)
                except Exception as exc:  # noqa: BLE001 - 单种子失败不拖累
                    logger.warning("知乎讨论搜索失败 keyword=%s: %s", keyword, str(exc)[:150])
                    continue
                for art in articles:
                    votes = art.get("like_count") or 0
                    if votes < ZHIHU_MIN_VOTES:
                        continue
                    signals.append(
                        {
                            "title": str(art["title"]),
                            "platform": "zhihu",
                            "source": f"知乎高赞:{keyword}",
                            "url": art.get("url") or "",
                            "provider": "tikhub",
                            "vertical_seed": vertical,
                            "signal_type": "validated",
                            "snippet": f"赞同 {votes}｜{(art.get('excerpt') or '')[:100]}",
                            "fetched_at": fetched_at,
                        }
                    )
        return signals

    async def collect_wiki_corpus(self) -> list[dict[str, Any]]:
        """维基类别页语料信号（结构性存量，检索免费；按天缓存不重拉）。"""
        import topics as settings_store
        import wikicategory

        cached = wikicategory.load_day_cache(settings_store.get_setting(wikicategory.CACHE_KEY))
        if cached is not None:
            return cached
        try:
            # 总闸超时：维基不可达时（网络波动/被墙）不能拖死整轮刷新，
            # 180s 拿不到就放弃本轮语料，让搜索信号先撑住生成
            signals = await asyncio.wait_for(wikicategory.collect_corpus(), timeout=180.0)
        except (asyncio.TimeoutError, TimeoutError):
            logger.warning("维基语料采集超时（180s），本轮跳过维基语料")
            signals = []
        except Exception as exc:  # noqa: BLE001 - 语料源失败不拖累其他信号
            logger.warning("维基语料采集失败: %s", str(exc)[:200])
            signals = []
        # 空结果不写当日缓存：一次网络抖动不应毒化整天（下一轮刷新会重试）
        if signals:
            settings_store.set_setting(wikicategory.CACHE_KEY, wikicategory.build_day_cache(signals))
        return signals

    async def collect_signals(self) -> list[dict[str, Any]]:
        """聚合六源语料（材料/周年/已验证内容/对标/知乎高赞讨论/维基语料）；全部失败才返回空。"""
        material, anniversary, validated, benchmark, zhihu, wiki = await asyncio.gather(
            self.collect_material_window(),
            self.collect_anniversaries(),
            self.collect_validated_content(),
            self.collect_benchmarks(),
            self.collect_zhihu_discussions(),
            self.collect_wiki_corpus(),
        )
        return material + anniversary + validated + benchmark + zhihu + wiki

    # 六源的可续采集：每通道完成即落账——外部看护 ~20 分钟重启一次服务，
    # 采集又是最贵的阶段（冷启动可超一个重启窗），不落账会陷入"采集中被杀
    # →续跑从零再采"的死循环；通道名 → collector 方法名
    _CORPUS_CHANNELS: tuple[tuple[str, str], ...] = (
        ("material", "collect_material_window"),
        ("anniversary", "collect_anniversaries"),
        ("validated", "collect_validated_content"),
        ("benchmark", "collect_benchmarks"),
        ("zhihu", "collect_zhihu_discussions"),
        ("wiki", "collect_wiki_corpus"),
    )

    def _load_corpus_partials(self) -> dict[str, list[dict[str, Any]]]:
        raw = store.get_setting(CORPUS_PARTIALS_KEY)
        if not raw:
            return {}
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            return {}
        if not isinstance(data, dict) or data.get("day") != date.today().isoformat():
            return {}
        channels = data.get("channels")
        return {k: v for k, v in (channels or {}).items() if isinstance(v, list)} if isinstance(channels, dict) else {}

    def _save_corpus_partials(self, partials: dict[str, list[dict[str, Any]]]) -> None:
        store.set_setting(
            CORPUS_PARTIALS_KEY,
            json.dumps({"day": date.today().isoformat(), "channels": partials}, ensure_ascii=False),
        )

    async def collect_signals_resumable(self) -> list[dict[str, Any]]:
        """可续版六源采集：每个通道完成即落账（不等整批），重启只补缺失通道。"""

        async def _one(name: str, coro) -> None:
            try:
                res = await coro()
            except Exception as exc:  # noqa: BLE001 - 单通道失败按当日空计，不无限重试
                logger.warning("选题语料通道 %s 采集失败（当日按空计）: %s", name, str(exc)[:160])
                res = []
            partials = self._load_corpus_partials()  # 重读最新（并发通道各写各的键）
            partials[name] = res
            self._save_corpus_partials(partials)

        partials = self._load_corpus_partials()
        pending = [(name, getattr(self, meth)) for name, meth in self._CORPUS_CHANNELS if name not in partials]
        if pending:
            await asyncio.gather(*(_one(name, coro) for name, coro in pending))
        complete = self._load_corpus_partials()  # 重读：含本轮刚完成的通道
        store.set_setting(CORPUS_PARTIALS_KEY, "")  # 全通道齐：清散账
        return [item for items in complete.values() for item in items]

    # --- 主流程：批量创意生成（生料层） ----------------------------------------

    async def run(self) -> IdeateResult:
        result = IdeateResult()
        # 当日状态两桶落账（采集是最贵的阶段，几十次搜索跑十几分钟）：外部看护
        # 可能每 ~20 分钟重启一次服务，重启后凭当日状态续跑（未发散线索 + 已发散
        # 待收敛的方向都不丢），不再重新采集——断点续跑让进度在任意重启节奏下累积
        clues, directions = self._load_day_state()
        if clues is None:
            signals = await self.collect_signals_resumable()
            if not signals:
                result.error = "语料采集为零条（全部通道失败或无结果）"
                return result
            clues, directions = signals, []
            self._save_day_state(clues, directions)
        # 当日已喂过的线索不再发散：同日多轮刷新各喂新料，直到当日线索池耗尽
        seen = self._load_ideate_seen()
        clues = [c for c in clues if fingerprint_of(c["title"]) not in seen]
        result.collected = len(clues)
        result.directions = len(directions)
        if not clues and not directions:
            result.error = "当日语料已全部喂过（次日换片续喂），本轮无新料"
            return result
        # 洗牌混垂类：语料按来源聚集，不洗牌会让单批垂类单一
        random.shuffle(clues)
        await self.ideate(clues, directions, result, seen)
        return result

    def _load_day_state(self) -> tuple[list[dict[str, Any]] | None, list[dict[str, Any]]]:
        """当日两桶状态：(未发散线索, 待收敛方向)；None 表示今天还没采过（要采集）。

        旧结构 {"signals": [...]}（单桶语料）迁移为线索桶——当天已采集的语料不重采。
        当日已耗尽（两桶皆空）返回空列表而非 None：同日再触发刷新不重采集，直接轮空。
        """
        raw = store.get_setting(IDEATE_CORPUS_KEY)
        if not raw:
            return None, []
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            return None, []
        if not isinstance(data, dict) or data.get("day") != date.today().isoformat():
            return None, []
        clues = data.get("clues")
        if not isinstance(clues, list):
            clues = data.get("signals") or []  # 旧单桶结构迁移
        directions = data.get("directions")
        return clues, directions if isinstance(directions, list) else []

    def _save_day_state(self, clues: list[dict[str, Any]], directions: list[dict[str, Any]]) -> None:
        store.set_setting(
            IDEATE_CORPUS_KEY,
            json.dumps(
                {"day": date.today().isoformat(), "clues": clues, "directions": directions},
                ensure_ascii=False,
            ),
        )

    def _load_ideate_seen(self) -> set[str]:
        """当日已喂语料指纹（按天存 app_settings；跨日自动重置）。"""
        raw = store.get_setting(IDEATE_SEEN_KEY)
        if not raw:
            return set()
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            return set()
        if not isinstance(data, dict) or data.get("day") != date.today().isoformat():
            return set()
        return {str(x) for x in data.get("fps") or []}

    def _save_ideate_seen(self, fps: set[str]) -> None:
        store.set_setting(
            IDEATE_SEEN_KEY,
            json.dumps(
                {"day": date.today().isoformat(), "fps": sorted(fps)[:IDEATE_SEEN_CAP]},
                ensure_ascii=False,
            ),
        )

    async def ideate(
        self,
        clues: list[dict[str, Any]],
        directions: list[dict[str, Any]],
        result: IdeateResult,
        seen: set[str],
    ) -> None:
        """两步生成：先发散（线索→方向清单，不筛选），再收敛（方向→过闸成片卡）。

        断点续跑顺序：先收敛上轮遗留的方向（最贵的发散已完成），再发散新线索。
        线索在发散成功后才记 seen——发散中途被杀的线索下轮重喂，方向不丢。
        """
        # 1) 收敛存量方向（上轮被杀时遗留的半成品）
        if directions:
            await self._converge(directions, result)
            directions = []
            self._save_day_state(clues, directions)
        # 2) 发散新线索 → 逐轮收敛
        for offset in range(0, len(clues), DIVERGE_CLUES_PER_BATCH):
            if result.batches >= IDEATE_BATCHES_CAP:
                break  # 发散调用次数到帽：剩余线索留在当日状态里，下轮续
            batch = clues[offset : offset + DIVERGE_CLUES_PER_BATCH]
            listing = [
                {
                    "index": idx,
                    "title": item["title"],
                    "source": item["source"],
                    "snippet": item.get("snippet") or "",
                }
                for idx, item in enumerate(batch)
            ]
            try:
                groups = await self._call_flow("diverge", {"corpus": listing})
            except Exception as exc:  # noqa: BLE001 - 单批失败只记日志，继续下一批
                logger.warning("选题发散本批失败: %s", str(exc)[:200])
                continue
            fresh = self._parse_directions(groups, batch)
            result.batches += 1
            seen.update(fingerprint_of(i["title"]) for i in batch)
            self._save_ideate_seen(seen)  # 发散成功即记喂过（空产出也算，贫瘠线索不反复重喂）
            if not fresh:
                continue
            result.directions += len(fresh)
            # 方向先落账再收敛：收敛中途被杀，重启后凭状态续收敛，不丢方向
            self._save_day_state(clues[offset + DIVERGE_CLUES_PER_BATCH :], fresh)
            await self._converge(fresh, result)
            self._save_day_state(clues[offset + DIVERGE_CLUES_PER_BATCH :], [])

    def _parse_directions(
        self, groups: Any, batch: list[dict[str, Any]]
    ) -> list[dict[str, Any]]:
        """发散输出 → 方向对象（复制线索上下文进来，收敛产出可回溯原型出处）。"""
        if not isinstance(groups, list):
            return []
        out: list[dict[str, Any]] = []
        for group in groups:
            if not isinstance(group, dict):
                continue
            idx = group.get("sourceIndex")
            clue = batch[idx] if isinstance(idx, int) and 0 <= idx < len(batch) else None
            if clue is None:
                continue
            for d in group.get("directions") or []:
                if not isinstance(d, dict):
                    continue
                name = str(d.get("name") or "").strip()
                sketch = str(d.get("sketch") or "").strip()
                if not name or not sketch:
                    continue
                out.append(
                    {
                        "title": clue["title"],
                        "url": clue.get("url") or "",
                        "snippet": clue.get("snippet") or "",
                        "source": clue.get("source") or "",
                        "signal_type": clue.get("signal_type") or "corpus",
                        "name": name,
                        "sketch": sketch,
                    }
                )
        return out

    async def _converge(self, directions: list[dict[str, Any]], result: IdeateResult) -> None:
        """方向分批过收敛 flow（成立性三问 + arc），产出的成片卡落库。"""
        for i in range(0, len(directions), CONVERGE_DIRECTIONS_PER_BATCH):
            chunk = directions[i : i + CONVERGE_DIRECTIONS_PER_BATCH]
            payload = {
                "directions": [
                    {
                        "index": j,
                        "clue": d["title"],
                        "clue_snippet": d.get("snippet") or "",
                        "name": d["name"],
                        "sketch": d["sketch"],
                    }
                    for j, d in enumerate(chunk)
                ],
                "verticals": verticals_payload(),
            }
            try:
                entries = await self._call_flow("ideate", payload)
            except Exception as exc:  # noqa: BLE001 - 单批失败只记日志，继续下一批
                logger.warning("选题收敛本批失败: %s", str(exc)[:200])
                continue
            if not isinstance(entries, list):
                continue
            for entry in entries[:CONVERGE_ENTRIES_CAP]:
                if (
                    isinstance(entry, dict)
                    and str(entry.get("scale") or "").strip().lower() == "series"
                    and str(entry.get("unitSpec") or "").strip()
                ):
                    await self._assemble_series(entry, chunk, result)
                else:
                    self._create_raw_card(entry, chunk, result)

    async def _assemble_series(
        self, entry: dict[str, Any], corpus: list[dict[str, Any]], result: IdeateResult
    ) -> None:
        """集合型题眼组系列选题：按单元规格检索收集候选 → 合成选集卡。

        候选单元不足 SERIES_MIN_UNITS 个不成卡（明记 series_missed，不做单片
        降级——单个种子案子撑不起系列是收敛层的判断，组题失败不推翻它）。
        """
        if result.series_created + result.series_missed >= SERIES_ASSEMBLE_CAP:
            result.series_missed += 1  # 名额用完：本系列不落，留给下一轮
            return
        if self.search is None:
            result.series_missed += 1
            return
        source_index = entry.get("sourceIndex")
        proto = corpus[source_index] if isinstance(source_index, int) and 0 <= source_index < len(corpus) else None
        if proto is None:
            result.series_missed += 1
            return
        theme = str(entry.get("theme") or entry.get("title") or proto["title"]).strip()
        unit_spec = str(entry["unitSpec"]).strip()
        queries = await self._plan_queries(
            "plan",
            {
                "title": proto["title"],
                "theme": theme,
                "reason": f"系列组题：按单元规格收集候选单元——{unit_spec}",
            },
            3,
        )
        if not queries:
            result.series_missed += 1
            return
        log = await execute_queries(self.search, queries)
        payload = {
            "theme": theme,
            "unitSpec": unit_spec,
            "seed": {"title": proto["title"], "snippet": proto.get("snippet") or ""},
            "candidates": _format_research_log(log, with_empty_hint=True),
        }
        try:
            out = await self._call_flow("series_compose", payload)
        except Exception as exc:  # noqa: BLE001 - 组题失败明记，不拖累其余收敛
            logger.warning("系列组题失败 theme=%s: %s", theme[:50], str(exc)[:200])
            result.series_missed += 1
            return
        if not isinstance(out, dict) or out.get("insufficient"):
            result.series_missed += 1
            return
        title = str(out.get("title") or "").strip()
        hook = str(out.get("hook") or "").strip()
        vertical = str(out.get("vertical") or "").strip().lower()
        arc = str(out.get("arc") or "").strip()
        units: list[dict[str, str]] = []
        seen_urls: set[str] = set()
        for u in out.get("units") or []:
            if not isinstance(u, dict):
                continue
            ut, uu = str(u.get("title") or "").strip(), str(u.get("url") or "").strip()
            if ut and uu and uu not in seen_urls:
                seen_urls.add(uu)
                units.append({"title": ut, "url": uu, "snippet": str(u.get("snippet") or "").strip(), "source": ""})
        if (
            not title
            or not hook
            or vertical not in VERTICALS
            or len(arc) < 12
            or "题眼" not in arc[:12]
            or "素材" not in arc
            or fingerprint_of(arc) == fingerprint_of(hook)
            or len(units) < SERIES_MIN_UNITS
        ):
            result.series_missed += 1
            return
        fingerprint = fingerprint_of(title)
        if store.exists_by_any_fingerprint([fingerprint]):
            result.duplicates += 1
            return
        tags = [str(t).strip() for t in (entry.get("tags") or []) if str(t).strip()][:4]
        if "单元选集" not in tags and "系列网格" not in tags:
            tags = (tags + ["单元选集"])[:4]
        try:
            store.create_topic(
                vertical=vertical,
                title=title,
                title_fingerprint=fingerprint,
                summary=hook,
                heat_evidence=units,  # 原型出处 = N 个真实候选单元
                research={},
                source=str(proto.get("signal_type") or "corpus"),
                stage="raw",
                tags=tags,
                arc=arc,
            )
            result.created += 1
            result.series_created += 1
            logger.info("系列组题成卡 title=%s units=%d", title[:40], len(units))
        except Exception as exc:  # noqa: BLE001 - 唯一约束冲突/单卡失败不拖累整批
            logger.info("系列组题落库跳过 fingerprint=%s: %s", fingerprint[:12], str(exc)[:120])
            result.duplicates += 1

    def _create_raw_card(
        self, entry: Any, corpus: list[dict[str, Any]], result: IdeateResult
    ) -> None:
        """校验并落一张生料卡；不合法/重复静默跳过（生料层宁缺毋滥在 flow 纪律）。

        arc（成片推演：跟拍谁/追查什么/从哪到哪）是成立性闸——模型给不出
        拍摄推演的条目就是新闻稿式选题（单点发现/事件/文物），代码侧再拦一道。
        """
        if not isinstance(entry, dict):
            return
        title = str(entry.get("title") or "").strip()
        hook = str(entry.get("hook") or "").strip()
        vertical = str(entry.get("vertical") or "").strip().lower()
        arc = str(entry.get("arc") or "").strip()
        if not title or not hook or vertical not in VERTICALS:
            return
        # arc 四段式（题眼/素材/呈现/弧线）：题眼=大主题（小事闸），素材=AIGC
        # 射程凭证（跟拍依赖型闸——依赖真人实拍的选题砍）；复读 hook 同判
        if (
            len(arc) < 12
            or "题眼" not in arc[:12]
            or "素材" not in arc
            or fingerprint_of(arc) == fingerprint_of(hook)
        ):
            result.rejected += 1
            return
        fingerprint = fingerprint_of(title)
        if store.exists_by_any_fingerprint([fingerprint]):
            result.duplicates += 1
            return
        source_index = entry.get("sourceIndex")
        proto = corpus[source_index] if isinstance(source_index, int) and 0 <= source_index < len(corpus) else None
        if proto is None:
            return  # 锚不到真实原型的选题不落库（不编造）
        tags = [str(t).strip() for t in (entry.get("tags") or []) if str(t).strip()][:4]
        try:
            store.create_topic(
                vertical=vertical,
                title=title,
                title_fingerprint=fingerprint,
                summary=hook,
                heat_evidence=[
                    {
                        "title": proto["title"],
                        "url": proto.get("url") or "",
                        "snippet": proto.get("snippet") or "",
                        "source": proto.get("source") or "",
                    }
                ],
                research={},
                source=str(proto.get("signal_type") or "corpus"),
                stage="raw",
                tags=tags,
                arc=arc,
            )
            result.created += 1
        except Exception as exc:  # noqa: BLE001 - 唯一约束冲突/单卡失败不拖累整批
            logger.info("生料卡落库跳过 fingerprint=%s: %s", fingerprint[:12], str(exc)[:120])
            result.duplicates += 1

    # --- 调研：LLM 规划的迭代取证 + 证据驱动的两级结论 -----------------------------

    async def _research_candidate(self, pick: TriagePick) -> list[dict[str, Any]]:
        """LLM 规划的迭代调研：计划查询 → 并行检索 → 看结果决定是否追查一轮。

        规划失败按零证据处理（结论自然降为观察）；查了什么、查到什么全程留痕。
        """
        if self.search is None:
            return []
        hot_title = pick.members[0]["title"]
        plan_payload: dict[str, Any] = {"title": hot_title, "theme": pick.theme, "reason": pick.reason}
        if pick.arc:
            plan_payload["arc"] = pick.arc  # 查询规划对着 arc 的题眼/素材主张去取证
        plan = await self._plan_queries("plan", plan_payload, RESEARCH_PLAN_MAX_QUERIES)
        if not plan:
            return []
        log = await execute_queries(self.search, plan)

        followup = await self._plan_queries(
            "followup",
            {"title": hot_title, "log": _format_research_log(log)},
            RESEARCH_FOLLOWUP_MAX_QUERIES,
        )
        if followup:
            log.extend(await execute_queries(self.search, followup))

        # 同题市场实查：真实播放计数进证据包，让结论的"对家与差异"有实证
        if self.market_probe is not None:
            try:
                log.extend(await self.market_probe(pick.theme))
            except Exception as exc:  # noqa: BLE001 - 实查失败不拖累文字取证
                logger.warning("同题市场实查失败 theme=%s: %s", pick.theme[:50], str(exc)[:200])
        return log

    async def _plan_queries(self, key: str, payload: dict[str, Any], max_queries: int) -> list[dict[str, str]]:
        """一次 LLM 查询规划调用；输出 [{label, query}]，失败/坏输出/done 返回空。"""
        try:
            raw = await self._call_flow(key, payload)
        except Exception as exc:  # noqa: BLE001 - 规划失败按零查询处理
            logger.warning("选题池调研规划失败(%s): %s", key, str(exc)[:200])
            return []
        if isinstance(raw, dict) and raw.get("done") is True:
            return []
        queries: list[dict[str, str]] = []
        if isinstance(raw, list):
            for item in raw[:max_queries]:
                if not isinstance(item, dict):
                    continue
                label = str(item.get("label") or "").strip()
                query = str(item.get("query") or "").strip()
                if label and query:
                    queries.append({"label": label, "query": query})
        return queries

    async def _plan_angles(self, pick: TriagePick, research_log: list[dict[str, Any]]) -> list[dict[str, str]]:
        """角度生成：取证证据 → 爆款角度模板 × 具体切口的候选方案（≤3 个）。

        规划失败/未配 flow 返回空——verdict 无 angleOptions 时按证据自选角度。
        """
        if not os.environ.get(FLOW_IDS["angle"], "").strip():
            return []
        try:
            raw = await self._call_flow(
                "angle",
                {
                    "title": pick.members[0]["title"],
                    "theme": pick.theme,
                    "evidencePack": _format_research_log(research_log, with_empty_hint=True),
                },
            )
        except Exception as exc:  # noqa: BLE001 - 角度规划失败不拦结论
            logger.warning("选题池角度生成失败 theme=%s: %s", pick.theme[:50], str(exc)[:200])
            return []
        options: list[dict[str, str]] = []
        if isinstance(raw, list):
            for item in raw:
                if not isinstance(item, dict):
                    continue
                template = str(item.get("template") or "").strip()
                angle = str(item.get("angle") or "").strip()
                if template and angle:
                    options.append(
                        {
                            "template": template,
                            "angle": angle,
                            "viewing_question": str(item.get("viewing_question") or "").strip(),
                            "unit_kind": str(item.get("unit_kind") or "").strip(),
                        }
                    )
                if len(options) >= ANGLE_OPTIONS_CAP:
                    break
        return options

    async def _generate_card(
        self,
        pick: TriagePick,
        research_log: list[dict[str, Any]],
        angle_options: list[dict[str, str]] | None = None,
    ) -> dict[str, Any] | None:
        """一次 verdict 调用产出证据驱动的两级结论；解析失败跳过该线索。"""
        payload: dict[str, Any] = {
            "theme": pick.theme,
            "reason": pick.reason,
            "title": pick.members[0]["title"],
            "priorContext": "",
            "evidencePack": _format_research_log(research_log, with_empty_hint=True),
        }
        if pick.arc:
            payload["arc"] = pick.arc
        if angle_options:
            payload["angleOptions"] = angle_options
        try:
            card_raw = await self._call_flow("verdict", payload)
        except Exception as exc:  # noqa: BLE001 - 单项失败不影响其它线索
            logger.warning("选题池调研结论生成失败 theme=%s: %s", pick.theme[:50], str(exc)[:200])
            return None
        return parse_verdict(card_raw, pick.members[0]["title"], research_log, angle_options=angle_options)

    # --- 观察卡复查：冲着立项缺口去查，证据变硬就升级 -------------------------

    async def rescan_observations(self, limit: int = RESCAN_BATCH_SIZE) -> RescanSummary:
        """轮转复查最久未扫的观察卡（每轮刷新尾部顺带跑，与主策展同锁内串行）。"""
        summary = RescanSummary()
        if self.search is None:
            return summary  # 未配置检索就没有"盯"的能力，不空转 LLM
        if not os.environ.get(FLOW_IDS["rescan_plan"], "").strip():
            logger.warning("未配置 %s，本轮跳过观察卡复查", FLOW_IDS["rescan_plan"])
            return summary
        for topic in store.list_rescan_candidates(limit, cooldown_hours=RESCAN_COOLDOWN_HOURS):
            try:
                outcome = await self.rescan_one(topic)
            except Exception as exc:  # noqa: BLE001 - 单张失败不拖累整批
                logger.warning(
                    "选题池观察卡复查失败 title=%s: %s", str(topic.get("title", ""))[:50], str(exc)[:200]
                )
                try:
                    store.mark_rescanned(str(topic["id"]))
                except Exception:  # noqa: BLE001
                    logger.exception("选题池复查标记失败 topic=%s", topic.get("id"))
                outcome = "failed"
            summary.rescanned += 1
            if outcome == "upgraded":
                summary.upgraded += 1
        return summary

    async def rescan_one(self, topic: dict[str, Any]) -> str:
        """单张观察卡的缺口导向复查；返回 upgraded / thin / failed（failed 也记扫描）。"""
        topic_id = str(topic["id"])
        if topic_id in _rescan_inflight:
            return "busy"
        _rescan_inflight.add(topic_id)
        try:
            return await self._rescan_one(topic)
        finally:
            _rescan_inflight.discard(topic_id)

    async def _rescan_one(self, topic: dict[str, Any]) -> str:
        topic_id = str(topic["id"])
        research = topic.get("research") or {}
        title = str(topic["title"])
        event = str(research.get("event") or "").strip()
        gaps = [str(g).strip() for g in research.get("gaps") or [] if str(g).strip()]
        observation = str(research.get("observation") or "").strip()
        if not gaps:
            gaps = ["事件事实与材料入口复核"]  # 旧卡缺口缺失时的兜底复查方向

        plan = await self._plan_queries(
            "rescan_plan",
            {"title": title, "event": event or "（无）", "gaps": gaps, "observation": observation or "（无）"},
            RESCAN_PLAN_MAX_QUERIES,
        )
        log = await execute_queries(self.search, plan) if plan else []
        if log:
            followup = await self._plan_queries(
                "followup",
                {"title": title, "log": _format_research_log(log)},
                RESCAN_FOLLOWUP_MAX_QUERIES,
            )
            if followup:
                log.extend(await execute_queries(self.search, followup))

        card = await self._rescan_verdict(title, gaps, observation, log)
        if card is not None and card["worth_it"]:
            store.upgrade_card(
                topic_id,
                title=card["title"],
                summary=card["summary"],
                angles=card["angles"],
                research=card["research"],
            )
            logger.info("选题池观察卡复查升级 title=%s", title[:50])
            return "upgraded"
        if card is None:
            store.mark_rescanned(topic_id)  # 结论失败也记扫描：坏卡不卡住轮转队列
            return "failed"
        store.record_rescan(topic_id, log)  # 仍薄：信源底账追加，观察内容原地保留
        return "thin"

    async def _rescan_verdict(
        self,
        title: str,
        gaps: list[str],
        observation: str,
        log: list[dict[str, Any]],
    ) -> dict[str, Any] | None:
        """复查结论复用初扫的 verdict 纪律；多给一段"先前观察"上下文，失败返回 None。"""
        prior_context = (
            "先前观察（本次为复查）：\n"
            f"- 观察结论：{observation or '（无）'}\n"
            f"- 立项缺口：{'；'.join(gaps)}\n"
            "本次复查重点：上面的缺口是否已被补上；新证据优先，旧结论里查无实据的部分维持不写。"
        )
        try:
            card_raw = await self._call_flow(
                "verdict",
                {
                    "theme": title,
                    "reason": "观察卡复查：先前的立项缺口是否已被补上",
                    "title": title,
                    "priorContext": prior_context,
                    "evidencePack": _format_research_log(log, with_empty_hint=True),
                },
            )
        except Exception as exc:  # noqa: BLE001 - 结论失败按仍不足处理
            logger.warning("选题池复查结论生成失败 title=%s: %s", title[:50], str(exc)[:200])
            return None
        return parse_verdict(card_raw, title, log)

    # --- 已深挖层：导演点名深挖生料卡（取证 → 角度 → verdict 全流程） ---------

    async def deep_dive_one(self, topic: dict[str, Any]) -> str:
        """深挖一张生料卡，证据足则升级为已深挖建议卡；薄则底账留痕仍是生料。

        返回 upgraded / thin / failed / busy。与观察卡复查共用同卡互斥。
        """
        topic_id = str(topic["id"])
        if topic_id in _rescan_inflight:
            return "busy"
        _rescan_inflight.add(topic_id)
        try:
            title = str(topic["title"])
            members = list(topic.get("heatEvidence") or []) or [
                {"title": title, "url": "", "snippet": "", "source": ""}
            ]
            pick = TriagePick(
                members=members,
                member_fingerprints=[str(topic.get("titleFingerprint") or "") or fingerprint_of(title)],
                vertical=str(topic.get("vertical") or "history"),
                theme=title,
                reason="导演点名深挖：对生料选题做完整取证与结论",
                arc=str(topic.get("arc") or ""),
            )
            research_log = await self._research_candidate(pick)
            angle_options = await self._plan_angles(pick, research_log)
            card = await self._generate_card(pick, research_log, angle_options)
            if card is None:
                store.mark_rescanned(topic_id)
                return "failed"
            if card["worth_it"]:
                store.upgrade_card(
                    topic_id,
                    title=card["title"],
                    summary=card["summary"],
                    angles=card["angles"],
                    research=card["research"],
                )
                _register_entities(topic_id, card.get("entities") or [], pick.members)
                logger.info("生料卡深挖升级 title=%s", str(card["title"])[:50])
                return "upgraded"
            store.record_rescan(topic_id, research_log)
            return "thin"
        finally:
            _rescan_inflight.discard(topic_id)


async def execute_queries(search: SearchFn, queries: list[dict[str, str]]) -> list[dict[str, Any]]:
    """并行执行一批查询；单条失败记空结果，不拖累整批。"""
    results = await asyncio.gather(
        *(search_one(search, query["query"]) for query in queries), return_exceptions=True
    )
    log: list[dict[str, Any]] = []
    for query, result in zip(queries, results):
        if isinstance(result, BaseException):
            logger.warning("选题池取证检索失败 query=%s: %s", query["query"], str(result)[:200])
            result = []
        log.append({"label": query["label"], "query": query["query"], "results": result})
    return log


async def search_one(search: SearchFn, query: str) -> list[dict[str, str]]:
    response = await search(query)
    return [
        {
            "title": str(r.get("title") or "").strip(),
            "url": str(r.get("url") or ""),
            "snippet": str(r.get("snippet") or "").strip(),
        }
        for r in response.get("results", [])[:RESEARCH_RESULTS_CAP]
        if str(r.get("title") or "").strip()
    ]


def parse_verdict(
    card_raw: Any,
    fallback_title: str,
    research_log: list[dict[str, Any]],
    angle_options: list[dict[str, str]] | None = None,
) -> dict[str, Any] | None:
    """把 verdict JSON 规整为 {worth_it, title, summary, angles, research, entities}。

    建议卡自称证据充分却给不出题目与角度：降为观察也不硬凑。观察卡沿用
    热点原文作题目（不编片名），认领/列表仍可用。坏输出返回 None。
    entities = verdict 从证据中抽取的具名实体（实体图谱的进料）。
    """
    if not isinstance(card_raw, dict):
        return None
    worth_it = str(card_raw.get("evidence_level", "")).strip().lower() == "strong"
    title = str(card_raw.get("title") or "").strip()
    summary = str(card_raw.get("summary") or card_raw.get("observation") or "").strip()
    raw_angles = card_raw.get("angles")
    angles = [str(a).strip() for a in raw_angles if str(a).strip()] if isinstance(raw_angles, list) else []
    unit_kind = str(card_raw.get("unit_kind") or "").strip().lower()
    viewing_question = str(card_raw.get("viewing_question") or "").strip()
    scale = str(card_raw.get("scale") or "").strip().lower()
    series_thread = str(card_raw.get("series_thread") or "").strip()
    # 爆款两把尺子（flow 输出新维度）：跟拍谁 + 观众为什么在意
    person_anchor = str(card_raw.get("person_anchor") or "").strip()
    emotion = str(card_raw.get("emotion") or "").strip()
    if scale not in SCALES:
        scale = "single"
    if scale == "series" and not series_thread:
        scale = "single"  # 没有串珠问题假设的系列是错觉，诚实地按单片
        series_thread = ""
    # 建议卡上架守卫：缺可拍单元或观看问题的卡与新闻卡无异，降为观察
    if worth_it and (not title or not angles or unit_kind not in UNIT_KINDS or not viewing_question):
        worth_it = False
        title = ""
        angles = []
    raw_gaps = card_raw.get("gaps")
    gaps = [str(g).strip() for g in raw_gaps if str(g).strip()] if isinstance(raw_gaps, list) else []
    # 实体抽取（图谱进料）：kind/name 校验，只留证据里具名的，上限 5 条
    entities: list[dict[str, Any]] = []
    raw_entities = card_raw.get("entities")
    if isinstance(raw_entities, list):
        for ent in raw_entities:
            if not isinstance(ent, dict):
                continue
            ent_kind = str(ent.get("kind") or "").strip().lower()
            ent_name = str(ent.get("name") or "").strip()
            if ent_kind in ENTITY_KINDS and ent_name:
                entities.append(
                    {"kind": ent_kind, "name": ent_name, "summary": str(ent.get("summary") or "").strip()[:200]}
                )
            if len(entities) >= 5:
                break
    chosen_template = str(card_raw.get("chosen_template") or "").strip()
    research: dict[str, Any] = {
        "evidence_level": "strong" if worth_it else "thin",
        "event": str(card_raw.get("event") or "").strip(),
        "why_now": str(card_raw.get("why_now") or "").strip(),
        "material_base": str(card_raw.get("material_base") or "").strip(),
        "competition_gap": str(card_raw.get("competition_gap") or "").strip(),
        "gaps": gaps,
        "source_map": research_log,
    }
    if chosen_template:
        research["chosen_template"] = chosen_template
    if angle_options:
        research["angle_options"] = angle_options
    if emotion:
        research["emotion"] = emotion
    if person_anchor:
        research["person_anchor"] = person_anchor
    if worth_it:
        research["unit_kind"] = unit_kind
        research["viewing_question"] = viewing_question
        research["scale"] = scale
        if series_thread:
            research["series_thread"] = series_thread
    return {
        "worth_it": worth_it,
        "title": title or fallback_title,
        "summary": summary,
        "angles": angles[:3],
        "research": research,
        "entities": entities,
    }


def _format_research_log(log: list[dict[str, Any]], *, with_empty_hint: bool = False) -> str:
    """把调研记录（标签/查询/结果）格式化为 prompt 段落或快照文本。"""
    if not log:
        return "（未执行任何检索）" if with_empty_hint else ""
    lines: list[str] = []
    for entry in log:
        label = str(entry.get("label", ""))
        query = str(entry.get("query", ""))
        lines.append(f"【{label}｜查询：{query}】")
        results = entry.get("results") or []
        if not results:
            lines.append("（未检索到）")
            continue
        lines.extend(
            f"- {str(item.get('title', ''))}｜{str(item.get('snippet', ''))} {str(item.get('url', ''))}".strip()
            for item in results
        )
    return "\n".join(lines)


def _register_entities(topic_id: str, ents: list[dict[str, Any]], heat_items: list[dict[str, Any]]) -> int:
    """把 verdict 抽出的实体落实体库并与选题卡关联；单实体失败只记日志。

    实体证据底账用本簇信号条目（标题+链接），上限 10 条。
    """
    evidence = [{"title": str(it.get("title") or ""), "url": str(it.get("url") or "")} for it in heat_items][:10]
    linked = 0
    for ent in ents[:5]:
        try:
            row = entity_store.upsert_entity(
                str(ent.get("kind") or ""),
                str(ent.get("name") or ""),
                summary=str(ent.get("summary") or ""),
                evidence=evidence,
            )
            entity_store.link_topic(topic_id, row["id"])
            linked += 1
        except Exception as exc:  # noqa: BLE001 - 单实体失败不拖累落卡
            logger.warning("实体登记失败 name=%s: %s", str(ent.get("name") or "")[:30], str(exc)[:120])
    return linked


def extract_json(text: str) -> Any:
    """宽容解析 LLM 输出的 JSON（剥离代码围栏与前后缀文字）。"""
    stripped = text.strip()
    if stripped.startswith("```"):
        stripped = stripped.split("\n", 1)[-1]
        stripped = stripped.rsplit("```", 1)[0]
    starts = [i for i in (stripped.find("["), stripped.find("{")) if i >= 0]
    if not starts:
        raise ValueError(f"no JSON found in LLM output: {text[:100]}")
    start = min(starts)
    end = max(stripped.rfind("]"), stripped.rfind("}"))
    if end <= start:
        raise ValueError(f"unbalanced JSON in LLM output: {text[:100]}")
    return json.loads(stripped[start : end + 1])


# ---------- 刷新编排：单飞 + 后台任务 + 结果落 settings ----------

RUN_STATE_KEY = "topic_pool_run_state"  # 刷新运行态标记（服务重启后被杀可被检测）


class TopicRefreshService:
    """选题池刷新服务：单飞守卫 + 后台 asyncio 任务 + 结果持久化。"""

    def __init__(self, curator: TopicCurator | None = None) -> None:
        self.curator = curator or TopicCurator()
        self._lock = asyncio.Lock()
        self._task: asyncio.Task[IdeateResult] | None = None

    @property
    def refreshing(self) -> bool:
        return self._lock.locked()

    def last_run(self) -> dict[str, Any]:
        raw = store.get_setting("topic_pool_last_run")
        if not raw:
            return {}
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return {}

    def start(self) -> bool:
        """启动一次刷新；已有刷新在跑时返回 False（单飞）。"""
        if self._lock.locked():
            return False
        # 运行态落账先于任务启动：服务重启杀任务后可检测出"被中断"
        store.set_setting(RUN_STATE_KEY, json.dumps({"startedAt": datetime.now(timezone.utc).isoformat()}))
        self._task = asyncio.create_task(self._run())
        return True

    async def _run(self) -> IdeateResult:
        try:
            async with self._lock:
                result = await self.curator.run()
                # 刷新尾部顺带轮转复查观察卡（锁内串行，防与手动深挖同卡双跑）
                try:
                    rescan = await self.curator.rescan_observations()
                except Exception:  # noqa: BLE001 - 复查失败不拖累主刷新的结果记录
                    logger.exception("选题池观察卡轮转复查失败")
                    rescan = RescanSummary()
            store.archive_stale(90)
            store.set_setting(
                "topic_pool_last_run",
                json.dumps(
                    {
                        "finishedAt": datetime.now(timezone.utc).isoformat(),
                        "rescanned": rescan.rescanned,
                        "rescanUpgraded": rescan.upgraded,
                        **result.__dict__,
                    },
                    ensure_ascii=False,
                ),
            )
            return result
        finally:
            store.set_setting(RUN_STATE_KEY, "")

    def report_interrupted_run(self) -> bool:
        """启动期检测：上轮刷新留有运行态标记 = 被服务重启杀掉，把中断落进 last_run。

        只在标记晚于 lastRun.finishedAt 时记（更早的标记属于已正常完成的旧轮）。
        返回 True = 确有被中断的刷新（生料层可断点续跑：语料缓存+已喂指纹
        都已落账，调用方可直接 SERVICE.start() 自动续跑）。
        """
        raw = store.get_setting(RUN_STATE_KEY)
        if not raw:
            return
        try:
            state = json.loads(raw)
        except json.JSONDecodeError:
            store.set_setting(RUN_STATE_KEY, "")
            return
        started_at = str(state.get("startedAt") or "")
        last = self.last_run()
        already = max(str(last.get("finishedAt") or ""), str(last.get("interruptedAt") or ""))
        found = False
        if started_at and started_at > already:
            last["interruptedAt"] = started_at
            last["error"] = f"刷新于 {started_at} 被中断（服务重启），本轮产出可能不完整"
            last.pop("finishedAt", None)
            store.set_setting("topic_pool_last_run", json.dumps(last, ensure_ascii=False))
            logger.warning("检测到被中断的选题池刷新：startedAt=%s", started_at)
            found = True
        store.set_setting(RUN_STATE_KEY, "")
        return found


SERVICE = TopicRefreshService()

# 手动深挖/自动轮转共用：正在复查的观察卡 id（防同卡双跑，跨两条路径互斥）
_rescan_inflight: set[str] = set()


# ---------- 手动深挖：单卡复查异步任务（jobId 轮询，先例 imgresearch.REF_JOBS） ----------

RESCAN_JOBS: dict[str, dict[str, Any]] = {}


def start_rescan_job(topic: dict[str, Any]) -> str | None:
    """启动单卡深挖任务；该卡已有复查在跑时返回 None。"""
    topic_id = str(topic["id"])
    if topic_id in _rescan_inflight:
        return None
    job_id = uuid.uuid4().hex[:12]
    RESCAN_JOBS[job_id] = {
        "jobId": job_id,
        "topicId": topic_id,
        "status": "running",
        "outcome": "",
        "error": "",
    }
    task = asyncio.create_task(_run_rescan_job(job_id, topic))
    _prune_rescan_jobs(task)
    return job_id


async def _run_rescan_job(job_id: str, topic: dict[str, Any]) -> None:
    job = RESCAN_JOBS.get(job_id)
    if job is None:
        return
    try:
        job["outcome"] = await SERVICE.curator.rescan_one(topic)
        job["status"] = "done"
    except Exception as exc:  # noqa: BLE001 - 任务结果如实上报
        job["status"] = "error"
        job["error"] = str(exc)[:300]
        logger.exception("选题池手动深挖失败 topic=%s", str(topic.get("title", ""))[:50])


def _prune_rescan_jobs(task: asyncio.Task) -> None:
    def _cleanup(t: asyncio.Task) -> None:
        done = [k for k, v in RESCAN_JOBS.items() if v["status"] in ("done", "error")]
        if len(done) > 50:
            for key in done[:-50]:
                RESCAN_JOBS.pop(key, None)

    task.add_done_callback(_cleanup)


def get_rescan_job(job_id: str) -> dict[str, Any] | None:
    return RESCAN_JOBS.get(job_id)


# ---------- 生料卡点名深挖：全流程取证任务（jobId 轮询；与复查共用互斥集） ----------

DEEP_JOBS: dict[str, dict[str, Any]] = {}


def start_deep_dive_job(topic: dict[str, Any]) -> str | None:
    """启动一张生料卡的深挖任务；该卡已在深挖/复查时返回 None。"""
    topic_id = str(topic["id"])
    if topic_id in _rescan_inflight:
        return None
    job_id = uuid.uuid4().hex[:12]
    DEEP_JOBS[job_id] = {
        "jobId": job_id,
        "topicId": topic_id,
        "status": "running",
        "outcome": "",
        "error": "",
    }
    task = asyncio.create_task(_run_deep_dive_job(job_id, topic))
    _prune_deep_jobs(task)
    return job_id


async def _run_deep_dive_job(job_id: str, topic: dict[str, Any]) -> None:
    job = DEEP_JOBS.get(job_id)
    if job is None:
        return
    try:
        job["outcome"] = await SERVICE.curator.deep_dive_one(topic)
        job["status"] = "done"
    except Exception as exc:  # noqa: BLE001 - 任务结果如实上报
        job["status"] = "error"
        job["error"] = str(exc)[:300]
        logger.exception("生料卡深挖失败 topic=%s", str(topic.get("title", ""))[:50])


def _prune_deep_jobs(task: asyncio.Task) -> None:
    def _cleanup(t: asyncio.Task) -> None:
        done = [k for k, v in DEEP_JOBS.items() if v["status"] in ("done", "error")]
        if len(done) > 50:
            for key in done[:-50]:
                DEEP_JOBS.pop(key, None)

    task.add_done_callback(_cleanup)


def get_deep_dive_job(job_id: str) -> dict[str, Any] | None:
    return DEEP_JOBS.get(job_id)


# ---------- 每日定时刷新（进程内调度，开关/时刻走 app_settings） ----------

AUTO_REFRESH_KEY = "topic_pool_auto_refresh"  # JSON {"enabled": bool, "time": "HH:MM"}
AUTO_REFRESH_LAST_DATE_KEY = "topic_pool_last_auto_run"  # "YYYY-MM-DD"，防重启后当天重复触发


def get_auto_refresh() -> dict[str, Any]:
    cfg: dict[str, Any] = {"enabled": False, "time": "08:00"}
    raw = store.get_setting(AUTO_REFRESH_KEY)
    if raw:
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            return cfg
        if isinstance(parsed, dict):
            cfg["enabled"] = bool(parsed.get("enabled"))
            cfg["time"] = str(parsed.get("time") or cfg["time"])
    return cfg


def set_auto_refresh(*, enabled: bool, time: str) -> dict[str, Any]:
    if not _valid_hhmm(time):
        raise ValueError("time 必须是 HH:MM（24 小时制）")
    cfg = {"enabled": bool(enabled), "time": time}
    store.set_setting(AUTO_REFRESH_KEY, json.dumps(cfg, ensure_ascii=False))
    return cfg


def _valid_hhmm(value: str) -> bool:
    if len(value) != 5 or value[2] != ":":
        return False
    hh, mm = value[:2], value[3:]
    return hh.isdigit() and mm.isdigit() and int(hh) <= 23 and int(mm) <= 59


def auto_refresh_tick(service: TopicRefreshService | None = None) -> str:
    """单次调度判定：开关开、当天未跑、已到点 → 触发一轮策展。

    返回 'fired' / 'skipped' / 'idle'。错过点（agent 重启晚于设定时刻）当天
    仍会补跑一次；与手动刷新撞车时下一分钟重试，当天仍会补上。
    """
    service = service or SERVICE
    cfg = get_auto_refresh()
    if not cfg["enabled"]:
        return "idle"
    now = datetime.now()
    today = now.strftime("%Y-%m-%d")
    if store.get_setting(AUTO_REFRESH_LAST_DATE_KEY) == today:
        return "skipped"
    if now.strftime("%H:%M") < cfg["time"]:
        return "skipped"
    if not service.start():
        return "skipped"  # 已有刷新在跑：日期不落账，下一分钟重试
    store.set_setting(AUTO_REFRESH_LAST_DATE_KEY, today)
    logger.info("选题池每日定时刷新已触发")
    return "fired"


async def auto_refresh_loop(interval_seconds: float = 60.0) -> None:
    """常驻调度循环：每分钟判定一次，自身异常只记日志不禁用。"""
    while True:
        try:
            auto_refresh_tick()
        except Exception:  # noqa: BLE001
            logger.exception("选题池定时刷新调度异常")
        await asyncio.sleep(interval_seconds)

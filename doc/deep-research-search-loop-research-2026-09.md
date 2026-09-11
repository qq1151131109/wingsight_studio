# 开源 Deep Research 的搜索反馈回路研究（2026-09-12）

用户判断：「现在的搜索是单向管线，主流 deep research 是搜→看效果和缺口→动态调整→再搜，agent 主导更灵活」。
本轮克隆 4 个开源项目读代码验证这个判断，并给出可落地的改造方案。

克隆位置：`~/Developer/agent-ref/deep-research/`
- `gpt-researcher`（assafelovic，标准路径 + 递归深度路径 + LangGraph 多智能体三套并存）
- `open-deep-research`（LangChain 官方，LangGraph，supervisor + researcher 两层）
- `deep-research-min`（dzhng，294 行极简递归，最适合看循环骨架）
- `open-deep-research-firecrawl`（nickscamara，Next.js 单链循环）

---

## 一、结论先行

**用户的判断成立，但需要一个更精确的表述**：业界共识不是「agent 主导」，而是
**「每轮检索后必有一个评估节点，它读累积发现、以结构化 JSON 产出『学到了什么 + 还缺什么 + 下一步搜什么』，下一轮由缺口驱动」**。
agent（tool-calling 循环）只是实现这一点的其中一种外壳——LangChain 用的是 supervisor agent，dzhng 用的是纯函数递归，Firecrawl 用的是 while 循环 + 一次 JSON 调用。**外壳不重要，评估节点的输入输出契约才是本体。**

我们现在的管线（`planner → search → download → select`）在 P3 之后已有**最弱形式的反馈**（终选推荐数 < 阈值 → 补搜），但反馈信号是**数量**（「推荐 N/M」）而不是**内容**（缺哪一类画面）。对照四个项目，这是核心差距。

---

## 二、四个项目的回路机制（代码级）

### 2.1 dzhng/deep-research（294 行，循环骨架最清晰）

`src/deep-research.ts:186-294`，递归实现：

```
deepResearch(query, breadth, depth, learnings, visitedUrls)
  ├─ generateSerpQueries(query, learnings, numQueries=breadth)   # :41-85
  │    prompt: "...use them to generate more specific queries: {learnings.join('\n')}"
  │    产出 [{query, researchGoal}]
  ├─ 并行 firecrawl.search 每个 query                             # :217-224
  ├─ processSerpResult(query, result) → {learnings[], followUpQuestions[]}  # :87-135
  └─ if depth > 0: nextQuery = `Previous research goal: {researchGoal}
                                Follow-up research directions: {followUpQuestions}`
      递归 deepResearch(nextQuery, ceil(breadth/2), depth-1, allLearnings, allUrls)   # :252-268
```

**这是四个项目里唯一把 `learnings` 真正喂回下一轮出词的**（`generateSerpQueries` 的 prompt 里显式说「用这些 learnings 生成更具体的查询」）。其余三个项目的 learnings 都只用于最终报告。

停止条件：机械的 `depth` 计数 + breadth 减半（`Math.ceil(breadth/2)`）；`visitedUrls` 跨分支传递去重。

评估 prompt（`:103-115`，`generateObject` + zod schema）：
> Given the following contents from a SERP search for the query `<query>{query}</query>`, generate a list of learnings from the contents… The learnings will be used to research the topic further.
> schema: `{learnings: string[], followUpQuestions: string[]}`

### 2.2 gpt-researcher（三套架构并存，只有一套有回路）

| 管线 | 入口 | 有回路吗 |
|---|---|---|
| 标准报告 | `skills/researcher.py:296` `_get_context_by_web_search` | **没有**（planner 出 N 个子查询 → 全并行 → 嵌入过滤 → 写） |
| 深度研究 | `skills/deep_research.py:380` `deep_research` | **有**（递归 + learnings + followUpQuestions） |
| LangGraph 多智能体 | `multi_agents/` | 有，但是**审稿环**不是搜索环 |

深度路径的评估节点 `process_research_results`（`deep_research.py:346-378`）：
> Given the following research results for the query '{query}', extract key learnings and suggest follow-up questions.
> schema: `{"learnings": [{"insight","sourceUrl"}], "followUpQuestions": ["..."]}`

下一轮查询靠 f-string 拼接（`:540-543`），没有独立的「据缺口出词」prompt。

**两个值得注意的事实**：
1. 它的标准路径（无回路）与我们现在的管线结构相同——说明「开环管线」在业界也存在，但它被定位为「快速报告」而非「深度研究」。
2. **`learnings` 在深度路径里是死数据**：累积、去重、拼进最终报告，但从未进入任何 query 生成 prompt（`:419` 是唯一读取点，只是 `copy()`）。跨分支唯一真实耦合是 `visited_urls`。

停止：纯机械（`depth > 1` 递归、breadth 地板 2）。**无充分性判据、无成本预算闸。**

### 2.3 LangChain open_deep_research（两层 agent，反馈在压缩报告上）

当前架构（`deep_researcher.py:699-719`）无 conditional_edges，全靠节点内 `Command(goto=...)`：

```
START → clarify_with_user → write_research_brief → research_supervisor → final_report_generation → END

supervisor 子图 (:351-363):
  supervisor ⇄ supervisor_tools   ← 回环
  退出：research_iterations > 6（默认）| 无 tool_calls | 调了 ResearchComplete   (:246-262)

researcher 子图 (:587-605):
  researcher ⇄ researcher_tools   ← 回环
  退出：不再调工具 | 调了 ResearchComplete | tool_call_iterations ≥ 10   (:456-503)
```

**反馈介质 = 子研究员的压缩报告**（不是原始搜索结果）：`supervisor_tools:305-330` 把每个 `ConductResearch` 派给一个隔离的子研究员，`asyncio.gather` 后把各自的 `compressed_research` 作为 ToolMessage 灌回 `supervisor_messages`。子研究员之间**互相不可见**，也不共享既往发现。

`think_tool`（`utils.py:219-244`）是**空壳**——不做任何计算，只回显 `f"Reflection recorded: {reflection}"`。反思完全靠 prompt 里 `<Show Your Thinking>` 的四问引导：
> 找到什么关键信息 / 缺什么 / 够不够 / 继续派还是收工

researcher prompt 里有一条一阶反馈信号（`prompts.py:170-173`）：
> **Stop Immediately When**: … Your last 2 searches returned similar information

**最有价值的发现：legacy/graph.py 有一个真正结构化的反思回环**（`:268-354`）：

```
generate_queries → search_web → write_section
                      ↑              |
                      └──(fail)──────┘      ← 显式回环
                         (pass 或 search_iterations ≥ max_search_depth) → END
```

grade 节点用**独立 planner model + 结构化输出**（`legacy/state.py:32-38`）：
```python
class Feedback(BaseModel):
    grade: Literal["pass", "fail"]
    follow_up_queries: List[SearchQuery]
```
grader prompt（`legacy/prompts.py:168-198`）：
> Evaluate whether the section content adequately addresses the section topic. If not, generate {N} follow-up search queries to gather missing information.

`max_search_depth` 默认 2（注释即 "Maximum number of reflection + search iterations"）。
**这是最小可移植单元**：一个 grader 调用 + 两个字段 + 一个 goto 回环。

### 2.4 Firecrawl open-deep-research（单链 while 循环）

`app/(chat)/api/chat/route.ts:475-600`，`maxDepth=7`（硬编码，LLM 改不了）、`timeLimit=4.5min`：

```ts
while (researchState.currentDepth < maxDepth && elapsed < timeLimit) {
  search(nextSearchTopic || topic)          // :497-521，无 URL 去重
  extract(urlToSearch + top3 urls)          // :546-549
  findings.push(...newFindings)             // :550
  analysis = analyzeAndPlan(findings)       // :561
  nextSearchTopic = analysis.nextSearchTopic // :564
  if (!analysis.shouldContinue || analysis.gaps.length === 0) break   // :595
}
```

评估节点 `analyzeAndPlan`（`:382-419`）——**输入是全部累积 findings 每轮重新序列化**（`:396`，O(n²) 的 token 增长）：
> What has been learned? What gaps remain? What specific aspects should be investigated next if any?
> schema: `{analysis: {summary, gaps[], nextSteps[], shouldContinue, nextSearchTopic, urlToSearch}}`

**`gaps[]` 是显式声明的缺口数组**，驱动下一轮（`:599` `topic = analysis.gaps.shift() || topic`）。
缺陷：无 URL ledger（同一 URL 可跨轮重复抽取）、`nextSteps` 是死字段、JSON 手工 parse（失败即当一次 strike）。

---

## 三、对照表与业界共识

| 维度 | dzhng | gpt-researcher（深度） | LangChain（当前） | Firecrawl | **我们** |
|---|---|---|---|---|---|
| 回路方式 | 递归调用 | 递归调用 | supervisor agent ⇄ tools | while + JSON | 固定 for 循环（≤5 轮） |
| 评估节点输入 | 单轮结果正文 | 分支压缩上下文 | 子研究员压缩报告 | **全部累积 findings** | 本轮候选（终选看图） |
| 评估输出 | `{learnings, followUpQuestions}` | `{learnings, followUpQuestions}` | 自由文本 think + 工具决策 | **`{gaps[], nextSearchTopic, shouldContinue}`** | `{recommended, note}`（note 存进 rec_reason 后丢弃） |
| 下一轮词来源 | 拼接 researchGoal + followUp | 同 | supervisor 自定 | `gaps` / `nextSearchTopic` | **planner 自由重出**（只知道「推荐 N/M」） |
| 学到的东西回流 | **✓ 进 prompt** | ✗ 死数据 | ✓（经压缩报告） | ✓（findings 数组） | ✗ |
| 停止判据 | 机械 depth | 机械 depth | 迭代上限 + 模型调 Complete | 语义（shouldContinue/gaps 空）+ 上限 | 推荐数 + 无进展 + 上限 |
| URL 去重 | ✓ visitedUrls | ✓ visited_urls | ✓ | ✗ | ✓（跨轮 seen 集） |

**五条共识**：

1. **评估节点的输出必须是结构化的「缺口清单」**，不是分数、不是自由文本。四个项目里三个的 schema 里都有 `followUpQuestions` 或 `gaps`。
2. **下一轮查询由缺口驱动，不由轮数驱动**。「还剩几轮」永远只是上限兜底。
3. **已发现内容必须能回流到出词环节**。dzhng 是唯一做对的；gpt-researcher 的深度路径把 learnings 攒着写报告却不用来出词——这是它的已知缺陷，值得引以为戒。
4. **停止 = 语义判据优先、机械上限兜底**（Firecrawl 的 `shouldContinue=false` / `gaps.length===0`；其余三家做得更差，纯计数）。
5. **`gaps` 这类判据的可靠性取决于评估者看到了什么**。LangChain 让主管只看压缩报告（信息有损）；Firecrawl 让评估者看全部 findings 但重序列化导致 token 爆炸。**给评估者的输入形态是个需要设计的取舍**。

---

## 四、我们的管线差在哪（逐条）

现状（`imgresearch._run_research`，P3 之后）：

```
for round in 1..5:
    planner(asset, rounds)          # rounds 里只有 {queries, found:"标题|宽高摘要；终选推荐 N/M"}
    search → prefilter → download
    select(本轮候选) → {recommended, note}
    if len(rec_order) >= 4: break
    if 连续 2 轮零推荐: break
```

三个具体差距：

**差距 1：反馈信号是数量，不是内容。**
planner 拿到的是「终选推荐 1/6」——它知道「这轮不行」，但不知道**为什么不行**：是画面全是山地村落（形制不对）？是全是新闻配图（性质不对）？是只有全景缺近景（覆盖不全）？
而这些信息**已经存在于终选的 `note` 里**（实测 note 写着「候选均缺乏片场美术、置景设计语境」「山地村落与城市街景均不符合设定」），只是我们把它塞进 `rec_reason` 就丢了，没有回传给 planner。**这是最便宜的一处修复。**

**差距 2：缺口分析者是错的角色。**
planner 只收到候选的 `标题|宽高` 文本摘要（`_rounds_summary`），**看不到图**。而判断「缺哪类画面」本质上需要看图——这正是终选模型（有视觉能力）擅长而 planner 不擅长的。业界共识第 5 条在这里的关键含义：**评估者必须是有能力判断缺口的那个角色**。我们的回路里有个视觉模型，却没让它做缺口分析。

**差距 3：发现池不累积成「已覆盖的视觉维度」。**
我们的 `all_rows` 是候选行列表，没有「已找到：村落全景航拍 ×3、门楼细节 ×1；缺失：巷道近景、室内陈设、年代道具」这种结构。所以补搜只能「换角度重来」，不能「定向补缺」。

---

## 四之二、A 档已落地（2026-09-12 同日，commit 443bb19）

终选 flow 输出契约扩展为 `{recommended, note, covered[], missing[]}`（`covered`=本批已能用作参考的画面维度、`missing`=资产要求但本批无一张能提供的维度），`skills.run_ref_select_flow` 透传并保序去重，`_run_research` 跨轮累积后经 `_gap_clause` 写进下一轮 planner 输入的 `found`，planner 提示词加「定向补缺」段（优先针对仍缺维度出词、已覆盖维度不重复搜、缺口为空才退回换角度）。

**实测（真链路，受控强制多轮）**：第 1 轮终选报「仍缺：土路接石桥的村口关系、一到两米窄巷与红砖围墙、尽端门楼院落、俯瞰全景」→ 第 2 轮 planner 出词「乐清 老村 石桥 村口 剧照」「温州沿海村落 窄巷 红砖围墙 空镜」「雪湾村 航拍 空镜」；第 3 轮继续针对「门楼院落」。逐条对应缺口。此前 planner 只会出「温州一家人 剧照」这类泛角度。

**仍暴露的下一层问题（B 档及以后的线索）**：定向补缺能精准命中缺口，但「命中」不等于「可用」——缺「土路接石桥的村口关系」时搜到的是桥梁档案照（老百晓集桥等资料站），形制对但画面是资料图，终选仍推荐了它。这指向两个后续动作：① B 档的覆盖度判停要区分「维度有图」与「维度有好图」；② 终选提示词的「必须是画面而不是资料图」条款对「定向补缺召回的档案照」还需更硬的判据。

## 四之三、B 档已落地（2026-09-12 同日，commit 7301303）

**判停升级**：`推荐数 ≥ 4` 从「停止条件」降级为「最低门槛」，新增缺口维度参与决策——推荐够但 `missing` 非空时定向追补，上限 `_GAP_CHASE_ROUNDS=2` 轮，且要求缺口在缩小（`missing_now < prev_missing`，补不动就止损）。耗时实测仍在 2 轮 126s 量级。

**covered 门槛收紧 + 一次反向修正**：原 covered 把「有资料图」也算覆盖（台账是假的）→ 收紧为「只有能当生图画面参考的才算」。但收紧后实测出现**过度拒绝**：旅游游记里的实景村落照片对生图是有用的（真实砖木老屋、巷道尺度、材质），却因为带「旅游」标签被一起拒，导致**零推荐**——诚实但产品价值为零。修正判据为「**纪实照片可用，只拒宣传物料**」：景区官宣海报、门票、攻略封面拼图、压文案的图才拒；优先级 影视置景 > 实景纪实 > 文旅物料(拒)，并明确「不要把『文旅街区是仿建』扩大成『与景区沾边就拒』」（区别在画面本身：仿建常有崭新仿古构件与商业招牌，不在来源域）。

**实测（真链路 2 轮 6 词 126s）**：修前 0 推荐 → 修后推荐 11 采纳 3；covered 报出「密集连片村舍与屋顶群俯视关系」「一到两米窄巷与老屋街巷尺度」等真实维度，missing 报出「土路接石桥的村口进入关系」等具体缺口，下一轮 planner 随即出「乐清村口 石桥 剧照」「温州乡村 门楼院落 美术设计」「乐清红砖民居 巷道 空镜」逐条对应。

**教训（写提示词时记住）**：收紧判据必然伴随过度拒绝的风险，一次收紧要配一次实跑复核。本轮「资料图不算覆盖」收紧后没有实跑就以为完成，实跑才发现零推荐——**判据改动必须真跑一轮看产出**，不能只看单测（单测只保证契约，保证不了模型行为）。

## 四之四、四类资产实测（2026-09-12，commit caf92f8）

用真实项目 091102（1980s 温州抬会案题材，无影视剧直接对应）的四类资产跑真实链路，每类一个代表：角色=郑乐芬（农妇）、服饰=83 式民警制服、场景=钱库镇老街、道具=手写账页。

| 类型 | 修前 | 修后 | 结论 |
|---|---|---|---|
| character | 3 张 80 年代农村老照片（造型参考） | 同类 3 张（换文章） | 稳定可用 |
| costume | 百科形制图 + 新闻配图 | 形制图 + 警服历史实景 + 新闻 | 类型化判据让形制图从「该拒」变「首选」 |
| scene | 宜兴/上海老街（地域完全错） | 苍南霞关老街 + 松阳古村 + 重庆古镇 | 1 张地域全对，降级参考带标注 |
| prop | **零推荐**（40 张全被当资料图拒） | 3 张（温州夫妻记账/金融手写/民间文书） | **质变** |

**三类真问题（已修）**：
1. **类型差异未被建模**（代价最大）：scene/character 要「在场景中/穿在身上的真实影像」，costume/prop 要「这东西长什么样」——对后两类实物照/展陈/结构图/特写**恰恰最有用**。B 档「资料图不算覆盖」一刀切同时造成两个方向的错：prop 该收的没收（零推荐）、costume 判据失效（形制图被当资料图放行）。
2. **地域/年代硬约束过死**：为治「宜兴老街当苍南老街」引入硬约束后，「温州/浙南老街作苍南参考」也被拒 → scene 零产出。改为分级：跨省/跨大区、现代仿古 → 拒；同文化区/相邻地域 → 降级参考但**必须标注**（note 写地域差异、missing 写「以同区域参考替代」）。**零参考不如标注清楚的近似参考**。
3. **planner 编造对应关系**：给郑乐芬出词「温州一家人 郑乐芬 剧照」（该剧无此角色）——同地域被误当同剧。已在 planner 提示词加防线（不确定就用「年代+地域+对象」出词）。

**遗留（未修，需产品决策）**：
- **零产出资产的用户引导**：1984 年钱库镇老街的照片公开网络上确实不存在（终选诊断极准：「候选15虽为浙南1980年代纪实照片，但地点是温州市区木勺巷而非钱库镇」），系统现在会精准报出 missing 清单，但用户在面板上看到什么、能做什么（手动搜/接受近似/改用考据文字生成）尚无设计。
- **跨大区漏网率**：分级后仍偶有「重庆古镇」这类明显异地被推荐，需继续观察（不宜为单例反复调提示词——AGENTS.md 已有「具体案例写进提示词就是过拟合」的教训）。
- **下载层损耗**：四类实测里每类都有 10-20% 下载失败（搜狐 SSL、403 防盗链、非位图响应）。

## 四之五、两组对照实测：有影视参照 vs 无（2026-09-12，commit d9b8087）

为回答「什么资产效果好」，用两极各跑四类：

| 类型 | 温州 1980s（无影视对应） | 唐代（有影视对应） |
|---|---|---|
| character | 80 年代农村老照片（年代对、非本人） | **《武则天》剧照**（同人物）✓✓ |
| costume | 83 式警服形制图 + 新闻图 | 唐代服饰解析文章配图（剧集服装）✓ |
| scene | 苍南霞关老街 + 松阳 + 重庆（地域）| **零/弱**：只有来源不可核实的聚合站图 ⚠️ |
| prop | 温州记账 / 金融手写 / 民间文书 | **上博绿釉烛台实物** + 学术文章 ✓ |

**规律**：有影视对应的资产，character/costume/prop 三类质量显著更高（能拿到同人物剧照、剧集服装解析、甚至博物馆实物）。**场景类是例外——两组都难**，且难的原因不同：
- 无影视对应（钱库镇老街）：缺「**那个具体地点**的影像」——1984 年苍南小镇的照片网上不存在。
- 有影视对应（唐代宫殿）：缺「**那个时代建筑内部**的真实影像」——现存唐代木构仅个位数且少内部空间照；影视剧的唐代宫殿多为搭景（明清化/影视化），终选如实判「现有藻井均为明清或明代形制」「本批无合格画面」。

**新修的两个缺陷**（本轮暴露）：
1. **3D 模型渲染图被采纳**（「唐代宫殿大殿室内SU模型-草图溜溜网」）：planner 提示词早有「不要用概念图/模型/素材这类词」的禁区，但**终选侧没有对应拒绝条款——上游禁区下游没兜住**。已补：3D 渲染图/素材站预览图/AI 生成图一律不选，判据是「这张图是拍出来的还是画/渲染出来的」。
2. **来源可核实性缺判据 + 多轮下标准漂移**：scene 第 2 轮自述「仅有明清建筑影像，不能覆盖」，第 4 轮却采纳了 Pinterest「唐朝宫殿内景-伤感说说吧」（标题无任何可核实信息）。已补：来源不可核实的候选只有画面含明确时代特征才可选；并明写「标准在每一轮保持一致，不要因为补了几轮就放低门槛」。复测 scene 推荐 4→1（收紧生效），其余三类仍稳定 3 张（无全局过度收紧）。

**结论：提示词能收紧标准，但变不出不存在的资源。** 场景类资产（尤其历史建筑内部）的参考图获取是结构性的难——这类资产的出路不在「搜得更好」，而在：① 从剧集视频抽帧（画面就是成片参考）；② 接受「形制文字考据 + AI 生成」的路径；③ 产品上明确告知用户「此类资产网上无合格参考」，并给出替代路径（当前系统已能精准报出 missing 清单，缺的是面板侧的引导设计）。

## 四之六、路径 2 落地：无参考图时考据升级为唯一依据（2026-09-12，commit ef69459）

资源稀缺资产（场景类尤其历史建筑内部）的出路，用户选定了「形制文字考据 + AI 生成」。

**勘查发现：通道早已存在，缺的是强度分级与告知。** `_inject_research_briefs` 一直把考据简报
并入 visual_notes，标记是「考据依据（真实形制与年代，优先遵循）」——但这个措辞**没有区分
「有参考图时考据是辅助」与「无参考图时考据是唯一依据」**。091101 武则天事故（52 张资产考据全到、
参考图 0 张，agent 一路出图都没觉得不对）正是这个缺口的代价。

**三处补齐**：
1. **出图措辞分级**（`_attach_brief`）：无参考图时升级为「考据依据（**本资产无可用参考图，
   以下文字是形制与画面的唯一依据，必须逐条落实到画面**）」——出图模型必须知道「这次没有图
   可比对」才会把文字吃透。哨兵词「考据依据」两种措辞都保留（`_ensure_research_brief` 靠它去重）。
2. **注入顺序改为 refs → briefs**（两处调用点）：分级判断需要先知道参考图是否落地。两个注入
   互不依赖（refs 只看 payload 自带参考、briefs 只看 visual_notes），换序安全。
3. **画布侧参考核查**：聊天侧早有 ref_gap 明报（agent 转达），但画布上直接点生成**不经过 agent**，
   用户拿不到。现落 `job.refGap` → 端点返回 `ref_gap` → `pollShotImageJob` 首次拿到时 toast
   （只弹一次；7 个批量出图调用点共用这一个入口）：「N 项没有参考图（只有文字考据约束形制）…
   建议先做参考图调研」。只提示不拦——用户要出就得能出。

**验证（真实注入链路）**：无参考的「钱库镇老街」→「唯一依据」措辞；有参考卡连线的「手写账页」
→ 仍是「优先遵循」。分级正确。回归：test_asset_research_brief 146 项（新增 I2 分级四断言）、
test_ref_select 79、test_ref_report 113 全绿；tsc/eslint 通过。

## 五、改造方案（图片检索特化，三档）

### A 档（最小改动，建议先做）— 让终选输出结构化缺口，回传给 planner

对应 legacy/graph.py 的 `Feedback(grade, follow_up_queries)` 模式。改一处 flow 输出契约：

**终选 flow 输出扩展**（`ref-research-select.json` SYSTEM_PROMPT 的输出段）：
```
输出严格 JSON：{"recommended":[候选index...],
               "note":"一句话说明取舍",
               "covered":["已覆盖的视觉维度，如：村落全景航拍/门楼细节"],
               "missing":["仍缺失的视觉维度，如：巷道近景/室内陈设/年代道具"]}
```
**`_run_research` 侧**：把 `missing` 与 `note` 一起写进下一轮 planner 的 `found` 摘要（替换现在的「终选推荐 N/M」字符串），planner prompt 加一段：
> `rounds[].missing` 是上一轮终选看图后判定的**缺失维度**——本轮查询要**针对性补这些维度**，而不是换一个泛泛的角度重来。

改动量：一个 flow 的输出契约 + `_rounds_summary` 一处 + planner prompt 一段。无需动循环结构。

### B 档（承 A，图片任务特有的关键一步）— 覆盖度台账

给资产维护一份轻量覆盖台账（进程内，`REF_JOBS` 或 job 字典即可，不必落库）：
```
covered = {维度: 命中候选数}   # 由每轮终选的 covered 累加
```
判停从「推荐数 ≥ 4」升级为**「推荐数 ≥ 4 且关键维度覆盖」（如 scene 要求 全景/近景/结构 各 ≥1）**。
这一档才真正让「缺口驱动」成立：补搜有靶子，停止有语义判据（对应共识第 4 条）。

### C 档（用户提到的「agent 主导」，改动大，建议后置）

把搜索循环从固定管线改为**主 agent 用工具驱动**：新增工具 `research_asset_refs(node_id, focus)`
返回「本轮候选摘要 + 已覆盖维度 + 缺失维度」，由 agent 决定是否再搜、搜什么、何时收工。
收益是灵活（agent 能结合剧本上下文、用户当轮的话来决定取舍）；成本是循环从确定流程变成 LLM 决策，
可测性下降、步数不可控。**建议在 A+B 跑稳、拿到「缺口驱动确实提升采纳质量」的证据后再做。**

### 不建议做的

- **不要引入「扩展查询」的多路召回**（一个种子词扩成 5 个变体再合并）：实测我们的问题不是召回数量不足，是查询形状与内容类型词（见 `89d10ae` 的结论）。业界这四个项目也都没有做查询扩展，都是「换角度重出」。
- **不要让评估者看全部原始候选**（Firecrawl 的做法）：O(n²) token 增长，且我们的终选已经受 50 张/批的上游限制。

---

## 六、验证方式（A 档落地后）

在现有 `test_ref_select.py` C 组基础上扩展：
1. **缺口回流**：mock 终选返回 `missing:["巷道近景"]`，断言下一轮 planner 收到的 `found` 里含该缺口文本。
2. **定向补搜**：断言 planner 调用参数里带缺口（真跑 planner 时人工核对出词是否针对该维度）。
3. 端到端（沿用 `/tmp/e2e_research.py` 的临时项目模式）：对比「有缺口回流」与「无缺口回流」两版的
   `采纳图维度分布`（人工看图判定：是否覆盖了全景/近景/结构三类），而不是只看采纳数量。

判定标准不是「采纳了几张」，而是**「采纳集合的视觉维度覆盖是否更全」**——这与我们真正的问题（参考图不够指导性）对齐。

---

## 附：四个项目里最值得反复读的三段代码

| 想学什么 | 读哪里 |
|---|---|
| 最小回路骨架（递归 + learnings 回流） | `deep-research-min/src/deep-research.ts:186-294`，特别 `:252-268` 的 nextQuery 拼接 |
| 结构化反思 + 回环（可直接移植） | `open-deep-research/src/legacy/graph.py:268-354` + `legacy/state.py:32-38` |
| 显式 gap 数组驱动循环 | `open-deep-research-firecrawl/app/(chat)/api/chat/route.ts:382-419`（评估）与 `:595-599`（判停） |

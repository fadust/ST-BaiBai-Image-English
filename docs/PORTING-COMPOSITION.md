# 构图生成机制分析与移植说明

> **English fork note:** This document was carried from the yyds composition analysis. Runtime UI/audit strings in this fork are English; Chinese aliases and protocol tokens remain where parsers need them.

> 回答两个问题：**插件（dsh-story-image）是怎么生成构图的？** 以及 **这套东西能不能移植到柏宝绘（ST-BaiBai-Image）？**
>
> 结论先给，证据后附。全部代码位置都取自已读过的源文件，函数名与行号可逐个回查；不贴大段源码，只引关键行与函数签名。
>
> 取证范围：
> - 插件侧 `lib/assemble.js` `lib/pipeline.js` `lib/promptdoc.js` `lib/lint.js` `lib/rules.js` `lib/guide.js`
> - 配置侧 `story-image/configs/moss-anime.md`、`story-image/prompts/specs/moss-anime.md`、`story-image/guards/char_block_guard.py`
> - 项目侧 `src/autoTag/shotspec.ts` `src/autoTag/prompt.ts` `src/state/settings.ts` `src/backends/comfyTemplates.ts` `src/state/charTags.ts`

---

## 0. 结论先行

**插件里根本没有「构图生成」这一层。** 构图不是被算出来的，是被写出来的 —— 由调用方的 LLM 在一条 `scene` 串里写完，插件只负责把它和别的东西拼在一起、再检查有没有写错。

插件里与构图沾边的只有三条**间接**机制，它们约束的是「人能怎么写」，不是「画面该怎么摆」：

| # | 机制 | 一句话作用 | 能不能凭空构图 |
|---|---|---|---|
| ① | 层序合同 | 决定谁拼在串尾（尾部权重高） | 不能，只定位置不定内容 |
| ② | 分工纪律 | 一件事只由一层说 | 不能，只防重复不产生画面 |
| ③ | lint 闸门 | 把显式矛盾在提交前打回 | 不能，只能否不能立 |

**项目侧的差别是结构性的，不是参数性的。** 柏宝绘是「tag + nl + characters」三段协议 + 渠道预设固定正面，插件是「单一 scene 串 + 层库拼接」。插件的层序合同搬不过来（柏宝绘没有风格档 / 形象块 / 剖面档这套层库），能搬的是 ② 与 ③：**把分工纪律与显式矛盾打回变成代码**。

**已落地的移植物**：`src/autoTag/shotspec.ts`（`parseShot` / `inspectFrame` / `blockingIssues` / `SHOT_ORDER_RULE` / `emitShotTag` / `inferContact`）。它是 ③ 的项目侧实现，另带一个 ② 的常量形态（`SHOT_ORDER_RULE`）。

### 0.1 与任务简报的三处出入（已核实）

写文档前按简报去核对，发现三处措辞需要修正；下面正文按**核实后**的口径写：

1. **`promptdoc.js` 不校验段数 / 编号 / 小标题。** 简报说它「只做形态校验（段数/编号/小标题）」，实际 `analyzePromptText`（`lib/promptdoc.js:223`）里没有任何段落计数逻辑。它查的是空串 / 超长 / 括号配平 / 权重区间 / 围栏与引号 / 换行 / 中文残留 / 否定句 / 质量词 / 画风词 / 重复标签 / 与形象块重合 / 与负向串冲突 / 四个槽位弱提示。「不写小标题、不写编号」这条只存在于**规范正文**（`prompts/specs/moss-anime.md` §2 的「不写小标题、不写编号」）和自查清单里，靠写手自己守，**没有任何代码判据**。
2. **`lint.js` 不做词表与重复项。** 简报说它「只做词表与重复项检查」，实际的词表与重复项在 `promptdoc.js`（`matchWords` / `findDuplicates`）。`lint.js` 是**子进程包装器**：`lintPrompt`（`lib/lint.js:209`）负责把串喂给外部脚本（`anime_lint.py` / `char_block_guard.py`），把脚本 stdout 最后一行 JSON 摊成 `{ warns, infos }`；它自己的唯一判据是 `lintBlockReasons`（`lib/lint.js:45`）—— `warns` 非空就拦。**插件自己的代码里没有构图词表。**
3. **层序拼接比简报写的多两档。** `buildPrompt`（`lib/assemble.js:70`）除了常规层拼，还有 `raw` 直通三档（`'plain'` / `'char'` / `'char+style'`），并且额外产出一条 `ignore` 串给 lint 当白名单。这三档不改变「不做构图」的结论，但说明它也不是纯粹的「层序拼接器」。

---

## 1. 插件里没有「构图生成」这一层

### 1.1 证据一：管线八个阶段里，没有任何一步产生构图

`lib/pipeline.js` 的编排是显式编号的，从 0 到 8：

| 阶段 | 位置 | 做什么 | 产出构图吗 |
|---|---|---|---|
| 0 输入校验 | `pipeline.js:614` | `prompt` 必填、超长报错、`assemble` 合法值 | 否，只拒绝空串与超长 |
| 1 配置集与角色 | `pipeline.js:632` | 解析配置集、加载身份档案、LoRA 账目 | 否 |
| 2 档层解析 | `pipeline.js:693` | 按参数 / 档案键取风格档与剖面档 | 否，只取已存在的档 |
| 3 拼装 | `pipeline.js:733` | 调 `buildPrompt` | 否，见 1.2 |
| 4 机械自查 | `pipeline.js:770` | 调 `lintPrompt` | 否，见 1.4 |
| 5 闸门 | `pipeline.js:805` | `lintBlockReasons` 非空则抛 | 否 |
| 6 dryRun | `pipeline.js:830` | 出完整信封不提交 | 否 |
| 7 出图 | `pipeline.js:841` | `generateMany` 提交 ComfyUI | 否 |
| 8 收图 | `pipeline.js:889` | 存图、回执 | 否 |

`prompt` 从 `args.prompt` 一路原样传到 `buildPrompt({ scene: promptText })`（`pipeline.js:738`），中间**没有任何一步读取剧情、改写机位、增删景别**。

### 1.2 证据二：`buildPrompt` 只做层序拼接

`lib/assemble.js:70` 的 `buildPrompt` 是全插件唯一的拼接权威点（文件头注释第一句就写死了这一点）。它的有效逻辑只有五行：

- `assemble.js:153` —— 画风永远最前（`parts.push(styleEntry.prompt)`）
- `assemble.js:154-155` —— 形象块与场景串按 `order` 二选一前后
- `assemble.js:156` —— 剖面档永远最后，注释写明理由：**「剖面永远最后（尾部权重最高）」**
- `assemble.js:142` / `assemble.js:160` —— `parts.join(', ')`
- `assemble.js:111-120` —— 场景串为空直接 `{ ok: false }`，注释：「拼接层不补任何词」

它对串**内容**的操作只有两件事：`trim()` 与丢弃空段。`assemble.js:15` 第三条纪律原文：**「接口不补任何词：不去重、不补质量词、不补默认负面、不剔词——写漏了画面就少什么。」** 这条纪律直接排除了「拼接层顺手优化构图」的可能。

### 1.3 证据三：`promptdoc` 的判据清单里没有构图

`analyzePromptText`（`lib/promptdoc.js:223`）的 ⑨ 组判据依次是：空/超长（①）、语法（②）、串形态（③）、中文残留（④）、否定句与质量词与画风词（⑤）、重复项（⑥）、与块库重合（⑦）、与负向串冲突（⑧）、槽位弱提示（⑨）。

唯一与构图占一点边的是 ⑨ 的槽位弱提示：`SLOT_WORDS`（`promptdoc.js:49-61`）里有 `shot` 组词表（`close-up` / `full body` / `from above` …），但：

- 它只做 `info` 级提示 —— `promptdoc.js:317` 注释「只做 info」，`promptdoc.js:321` 的文案自称「弱提示，判据故意保守」；
- 它判的是**「有没有写景别词」**，不是**「几个景别词、互不互斥」**；
- 它只认 ASCII 标签流（`matchWords` 按整词边界匹配，见 `promptdoc.js:175`），中文散文段在 `moss-anime` 这种 `promptMultiline: true` 的线上根本进不了这套判据。

也就是说：**一张图里同时写「中近景」和「全身」，`promptdoc` 抓不到。**

### 1.4 证据四：`lint` 只转述外部脚本的结论

`lintBlockReasons`（`lib/lint.js:45`）三行读完：

```js
if (!lint || lint.skipped) return []
return Array.isArray(lint.warns) ? lint.warns : []
```

判据就是「外部脚本吐了 warns 就拦」。真正的判据在外部 python 脚本里 —— 以本项目真用的 `guards/char_block_guard.py` 为例，它查的是**形象块复述**（外观组 / 体貌组 / 年龄人种 / 逐字回声），文件头第 13-20 行把五条判据列全了，**没有一条是构图**。

而且这套闸门是**故意 fail-open 的**：`lib/lint.js:50-53` 的 `skippedOut` 让脚本缺失、超时、输出非 JSON 全部降级成 `{ skipped }` 并放行；文件头第一条纪律还特意骂过一个把配置开关叠进判据的写法（会「静默放行」出假绿）。设计取向很清楚：**闸门只做好「能判的那一小撮」，判不了就闭嘴让图出去。**

### 1.5 证据五：插件自己不调 LLM

在 `lib/` 全目录 grep 模型调用入口（`requestCompletion` / `chat.completions` / `generateText` / `openai`）：**0 命中**。

插件没有模型，就不可能「生成」任何内容 —— 包括构图。它唯一的输入就是 `args.prompt`。

### 1.6 那构图到底从哪来：写串的人

`pipeline.js:615-619` 的空串报错文案把这件事说得最直白：

> 缺少 prompt —— 提示词由调用方自己写：先 get_image_guide 拿写法要点，再把完整的 scene 串传进来（人物 / 穿着 / 场景 / 光线 / 动作）

`lib/guide.js:45-51` 的 `WRITING_POINTS` 五条是给写手的纪律，第一条就是构图：

> 只写 scene：人 / 穿 / 场 / 光 / 镜（谁在做什么、穿成什么样、在哪、什么光、什么机位）。

**「什么机位」是写手的责任，不是代码的责任。** 这是整份文档的前提 —— 插件管的是「别把已经写好的东西拼坏」，不是「把画面想对」。

---

## 2. 插件真正管构图的三条间接机制

### 2.1 机制①：层序合同（谁在串尾，谁的权重高）

**实现**：`assemble.js:153-156` 的五行 push 顺序，加上不同模型对位置敏感这一事实。

**它能做什么**：

- 保证「画风永远最前、剖面永远最后」这件事**不依赖写手的记性**。写手只要把内容写进正确的层，位置由代码定。
- 让「想加强某个镜头」变成可操作的行为：把剖面档（特写、局部、插入镜头）挂在尾部，权重自然更高 —— 不需要让写手在串里加权重语法。
- 给回执一个稳定形状：`blocks` 记「解析到了什么」，`ignore` 记「哪些词来自档层」。这两样都进 lint 白名单（`assemble.js:167` `ignoreString`）。

**它做不到什么**：

- 不知道这一格该用全景还是近景 —— 它连「景别」这个概念都没有（`lib/` 全目录 grep 构图关键词，只有 6 处命中，全是注释和那个弱提示词表）。
- 不理解层与层之间的语义冲突。层顺序正确、内容互相打架的串，它照样拼、照样 `ok: true`。
- 位置敏感的假设本身有边界：`join(', ')` 拼出来的是一行 tag 流，尾部权重高是 tag 流模型（CLIP / T5 那类）的经验；换成 MOSS 这种吃中文自然段的 Qwen3.5 编码器，整条串是**一条连贯散文**，「尾部权重」这回事基本不成立。所以 `moss-anime` 线干脆不用层拼（走 `raw` / 纯散文），构图全押在提示词规范上。

### 2.2 机制②：分工纪律（一件事只由一层说）

**实现**：三处，都在文本层：

- `lib/assemble.js:12-15` 的文件头红线 1：「**一件事只由一层说**：画风归风格档、剖面归剖面档、机位/姿态/布景归场景串」；
- `lib/guide.js:45-51` 的五条写作要点（写什么 / 不写画风 / 不重复外貌 / 不写质量词与否定句 / 信息不足时选最有张力的瞬间）；
- 配置集正文：`configs/moss-anime.md` 的「### 画风层」（第 56-73 行）与 `prompts/specs/moss-anime.md` §2（第 30-41 行）、§9 禁止项（第 200-209 行）里的「**不把同一件事两层说**」。

**它能做什么**：

- 让「同一个事实只有一个真源」。机位只许写在场景串里，画风只许写在风格档里 —— 于是「改一处」是有效操作，不会出现「改了风格档但串里还留着旧画风词」这种双份条件。
- 是唯一一条**真的在管构图**的纪律：`assemble.js:13` 明确把「机位」划给场景串。这条划线意味着「机位不许由档层决定」，反向保护了写手对镜头的全部控制权。
- 落到项目侧有现成对应物：`story-image/prompts/specs/moss-anime.md` §3 第 5 条 —— 中文段只写动作 / 穿着 / 环境 / 光线，外貌归形象块，由 `guards/char_block_guard.py` 强制。这是「分工纪律」从散文变成代码的**唯一一个成功案例**。

**它做不到什么**：

- 它只是一句话。除了外貌那一项外，**没有任何代码在检查「机位是不是被两处说了」**。
- 它管「重复」，不管「矛盾」。「中近景 + 三层纵深」不是重复，是矛盾 —— 分工纪律对这类完全失明。

### 2.3 机制③：lint 闸门（把显式矛盾在提交前打回）

**实现**：`lintPrompt`（`lib/lint.js:209`）+ `lintBlockReasons`（`lib/lint.js:45`），拦截点在 `pipeline.js:805-828`（`buildPrompt` 之后、`generateWithComfy` 之前）。

**它能做什么**：

- 拦「不看图就能判」的硬伤：形象块复述（`char_block_guard.py` 判据 1、2、5）、未知标签、重复项、括号不配平。这类错误的共同点是**形式可判、结果可复现、零 token**。
- 给出可读的修法。`promptdoc.js:64-86` 的 `CODE_FIX` 每个 code 都配一句「怎么改」，报告里逐条给动作 —— 不给动作的诊断等于没诊断。
- 闸门形态可复用：**纯函数判据 + 调用点单一 + 失败降级**。这套结构跟「判什么」无关，可以整体搬到别的项目。

**它做不到什么**：

- 判据在插件外面（python 脚本），插件本身没有词表。想加一条构图判据，得改脚本或接新脚本。
- 只判「写了什么词」，不判「这组词在几何上成立不成立」。`from above` + `lying on back` 这种组合它一个字都不会说。
- 拦的粒度是整条串：一条 warn 就把这次出图拦掉，没有「这条只是提示」的中间态（`lintBlockReasons` 只认 `warns`，`infos` 不拦）。所以判据稍微激进一点就会把正常图顶死 —— 这也是它为什么只敢判形式。

### 2.4 三条机制的共同边界

把三条摆在一起，边界很清楚：

- 它们全部作用在**文本层**，全部是**否定式**（不许这样写、不许重复、不许同时在两处），没有一条是**生成式**（「这一格应该这么摆」）。
- 它们的信息来源全是「写手已经写下的字」，没有任何一条会去问「这一格剧情需要什么」。
- 它们能拦住的是**写错的串**，拦不住**想错的画面**。而「画面不对」在实践里绝大多数是后者 —— 这正是 `src/autoTag/shotspec.ts` 文件头第 4-7 行写的那句话：「散文天生不闭环」。

---

## 3. 项目侧生成链路与插件的差别

### 3.1 两条链路的形态对照

| 维度 | 插件 dsh-story-image | 柏宝绘 ST-BaiBai-Image |
|---|---|---|
| 谁写内容 | 主会话的 LLM（插件外） | 内置自动 tag 流水线（`src/autoTag/prompt.ts`） |
| 提示词单元 | **一条 `scene` 串** | **`tag` + `nl` + `characters` 三段** |
| 拼接点 | `assemble.js` `buildPrompt`（唯一权威点） | `comfyTemplates.ts` `composePositive`（后端层） |
| 拼接次序 | 风格档 → 形象块 → scene → 剖面档 | 固定正面 → tag → nl → 中文外貌 |
| 层库 | 有：`styles/styles.md`、`cutaways/cutaways.md`、`identities/*.md` | 无档库；画风 = 渠道预设 `positive` + LoRA |
| 角色外貌 | `char_block` 逐字注入（`rules.js:180` `parseIdentity`） | 固定外貌库 + `chineseAppearanceForText` 按名字认人（`charTags.ts:568`） |
| 出图前文本闸门 | 有（`lint.js` + 外部 python） | **没有**（全目录 grep `lint` / `anime_lint`，非测试代码里只有 `st/keyboard.ts` 的 `guardEditableArrowKeys`，与提示词无关） |
| 版式 | 规范正文 + `layoutLock` | `layoutLock`（`settings.ts:1651`）+ `prompt.ts` 的 `layoutRule` |
| 验收判据 | `lint` warns 非空则拦 | `protocol.ts:174` `parseImagePlan`：结构 / 位置 / 数量，**不判内容** |

### 3.2 柏宝绘的拼接点在哪，为什么它不构成「层序合同」

`comfyTemplates.ts:398` 的 `composePositive`：

```ts
if (isMossTemplate(simple.template)) return joinParts(simple.positive, values.prompt, nl, values.appearance)
return joinParts(simple.positive, nl || values.prompt)
```

顺序是硬的、有语义的（「中文外貌不在 tag 里，所以必须由这里补在最后」），但它与插件的层序合同差三件事：

1. **没有「层」这个单位**。它拼的是三个**协议字段**，不是可选的层库条目。字段是固定的、必须都在的东西；层是可选的、可以解析失败的注入物。
2. **没有权重语义**。`joinParts` 就是逗号拼接（`comfyTemplates.ts:382`），没有任何位置说明。而插件的层序合同全部意义在于「尾部权重最高」。
3. **不做白名单**。插件 `buildPrompt` 会同时产出 `ignore` 串（`assemble.js:167`），喂给 lint 跳过档层词汇；柏宝绘的拼接不产出任何供下游校验的旁路产物。

**结论：柏宝绘已经有一条「单行拼接」，但没有「层序合同」，也不该为了移植去造一套层库。** 造出来只会得到一个没人维护的档库加上一条解释不清的拼接规则。

### 3.3 能移植的是 ② 与 ③

逐条对照插件三条机制在柏宝绘的可行性：

- **① 层序合同 —— 不适用**。柏宝绘没有风格档 / 形象块 / 剖面档，没有「可选层」，也没有尾部权重假设（MOSS 线的 Qwen3.5 编码器吃连贯中文，不吃 tag 流位置偏置）。
- **② 分工纪律 —— 已在，缺机器判据**。柏宝绘的规范正文（`settings.ts:765` `DEFAULT_MOSS_ANIME_SPEC` §一 / §九）已经把「同一件事不许写两遍」写成条款，`prompt.ts:320-322` 的 `contentRule` 也把 tag 与 nl 的分工写死了。缺的是**判据**：没有代码检查「tag 说了客厅、nl 又说了一遍客厅」。这一项最适合移植成词表 + 纯函数。
- **③ 闸门 —— 完全空缺，且结构可搬**。柏宝绘目前没有出图前文本闸门，`parseImagePlan` 只验结构。把插件那套「纯函数判据 + 单一调用点 + 失败降级」搬过来即可，判据换成构图判据。

**移植的关键取舍**：输出**必须降级成 warn，不能阻断**。理由来自项目侧的既有纪律 —— 插件闸门是整串粒度的，一条 warn 就拦；柏宝绘的流水线后面还挂着出图队列与楼层动画，一个误判会直接毁掉一次生成。所以 `shotspec.ts:347` 的 `blockingIssues` 只返回 block 级，而调用方被要求把它降级成 warn（见任务板 task-1 第 3 条）。

---

## 4. 移植清单

| 机制 | 插件侧实现 | 柏宝绘对应物 | 能否移植 | 落地文件与符号 |
|---|---|---|---|---|
| 构图结构化词表 | 无（`promptdoc.js` 只有 `SLOT_WORDS` 弱提示） | 无 | **可移植（已落地）** | `src/autoTag/shotspec.ts` `SIZE_TABLE` / `ANGLE_TABLE` / `HEIGHT_TABLE` |
| 词表归并（防误判） | `promptdoc.js:108` `normalizeTag`（只归一化写法，不归并同义） | 无 | **可移植（已落地）** | `shotspec.ts:142` `harvest`（按别名长度降序 + 命中即抹除） |
| 承重墙顺序常量 | 只有散文（`guide.js:45` 五条、`specs/moss-anime.md` §8.1 三样） | `DEFAULT_MOSS_ANIME_SPEC` §二 + 思维链第 4 步 | **可移植（已落地）** | `shotspec.ts:352` `SHOT_ORDER_RULE`、`shotspec.ts:183` `emitShotTag` |
| 显式矛盾打回 | `lint.js` 闸门 + 外部脚本（形象块复述那一类） | 无 | **可移植（已落地，但未接线）** | `shotspec.ts:244` `inspectFrame`、`shotspec.ts:347` `blockingIssues` |
| 分工纪律条款 | `assemble.js:12-15` 红线 + `guide.js:45` 五条 | `prompt.ts:320-322` `contentRule` + `DEFAULT_MOSS_ANIME_SPEC` §一/§九 | **已有等价物** | `src/autoTag/prompt.ts` `contentRule` / `layoutRule` |
| 规则以「常量」形态复用 | 无（规则是散文） | 无 | **可移植（已落地）** | `SHOT_ORDER_RULE` 导出，供 `prompt.ts` 的 rules 数组直接拼 |
| 层序合同 | `assemble.js:153-156` | `composePositive`（单行拼接，无语义） | **不适用** | —— |
| 形象块注入 | `rules.js:180` `parseIdentity` + `assemble.js:124-127` | `charTags.ts:568` `chineseAppearanceForText` + `composePositive` | **已有等价物，不需要** | `src/state/charTags.ts` |
| 风格档 / 剖面档库 | `rules.js:603` `parseLibrary` / `resolveEntry` / `loadLibrary` | 无 | **不能移植** | —— |
| LoRA 挂载 | `rules.js:155` `withLoraStrength` + `pipeline.js:859` | `simple.loras`（`comfyTemplates.ts:416`） | **已有等价物，不需要** | `src/backends/comfyTemplates.ts` |
| 分镜页版式 | `specs/moss-anime.md` §8 + `layoutLock` | `settings.ts:1651` `LayoutLock` + `prompt.ts:349` `layoutRule` | **已有等价物（另一条路）** | `src/state/settings.ts:1684` `activeLayoutLock` |
| 闸门 fail-open 纪律 | `lint.js:50-53` `skippedOut` | 无 | **应移植（纪律，不是代码）** | `inspectFrame` 永不 throw；调用方降级 warn |
| 诊断报告与修法 | `promptdoc.js:64` `CODE_FIX` | 无 | **可移植（形态）** | `ShotIssue` 的 `code` / `message` / `fix` 三件套 |

### 4.1 `shotspec.ts` 的符号逐条对应

- `parseShot`（`shotspec.ts:163`）—— 对应插件的 `promptdoc.js:97` `splitTags` + `108` `normalizeTag` 那一层的「解析」角色。差别在于 `parseShot` 返回**多值**（`sizes[]` / `angles[]` / `heights[]`），把冲突判定交给下游 —— 插件那边的解析是给「查词」用的，天生不产冲突。
- `inspectFrame`（`shotspec.ts:244`）—— 对应插件的 `analyzePromptText`（`promptdoc.js:223`）的**角色**（主判据 + 分级 findings），但判据换成了构图可行性：`size-conflict` / `angle-conflict` / `size-crowded` / `size-overlayered` / `profile-occlusion` / `portrait-row` / `closeup-relationship`。插件没有任何一条同类判据。
- `blockingIssues`（`shotspec.ts:347`）—— 对应 `lintBlockReasons`（`lint.js:45`）：都是「从 issues 里挑出值得拦的那部分」。差别是 `blockingIssues` 是纯函数、不读任何配置开关 —— 正是 `lint.js:5-8` 那条纪律（「判据只读 lint 内容，不读任何配置开关」）的项目侧贯彻。
- `SHOT_ORDER_RULE`（`shotspec.ts:352`）—— 对应 `guide.js:45` `WRITING_POINTS` 与 `specs/moss-anime.md` §8.1 那句「格位 + 景别 + 机位三样必须同时出现」。升级点：它是**可被 `prompt.ts` 直接 import 的常量**，不再是只在文档里的散文。
- `emitShotTag`（`shotspec.ts:183`）—— 插件没有对应物。它把 `{people, size, angle, height}` 按承重墙顺序拼成一行，与 `DEFAULT_MOSS_ANIME_SPEC` §二的 tag 口径（人数 → 景别 → 机位朝向 → 地点 → 光的方向）同序。
- `inferContact`（`shotspec.ts:198`）—— 插件没有对应物。它从串里粗判两人贴身程度（`none` / `near` / `body`），只认最硬的几个动词，供 `profile-occlusion` 使用。这是「几何可行性」唯一一处需要**语义**的地方，所以作者刻意做得极保守。

---

## 5. 不能移植的部分与理由

### 5.1 风格档 / 剖面档库

插件的风格档与剖面档是**可维护的文本库**（`styles/styles.md` / `cutaways/cutaways.md`），由 `lib/rules.js:603` `parseLibrary` 解析成 `{ id, label, prompt }`，再由 `resolveEntry` 按 id 或显示名取用。它的价值建立在两件事上：① 一个串由多层组成，层可以自由组合；② 有 `--ignore` 白名单机制，让档层词汇不被 lint 当成串内词汇。

柏宝绘两件事都没有。画风由渠道预设的固定 `positive` 承担（`comfyTemplates.ts:398` 的第一个参数），LoRA 由 `simple.loras` 挂载，**画风是一套预设的属性，不是可选的层**。硬造一个档库会立刻遇到 `moss-anime.md:106` 记的那个坑：插件档库在进程内缓存（`libraryCache`），新建档必须重启才认 —— 一个需要重启才生效的配置面，在柏宝绘这种「改完下一张即生效」的产品里是负资产。

### 5.2 形象块注入（char_block 逐字注入）

插件的注入路径是「档案文件 → `parseIdentity` → `char_block` 字符串 → `buildPrompt` 拼进串」。它依赖三件事：档案目录结构、`char_block` 字段约定、以及 `line` 门禁（角色档案绑定到某套配置集，`rules.js:466` `identityLineMatches`）。

柏宝绘走的是**固定外貌库**：`state/charTags.ts` 的 `CHAR_TAG_FIELDS` 七字段 + `buildEntryTag`（`charTags.ts:176`）拼英文 tag，`chineseAppearanceForText`（`charTags.ts:568`）在**发请求前**按「名字字面出现在 tag+nl 里」认人、现取中文外貌。两种认人方式根本不同：插件认文件与别名，项目认字面名字。而且项目侧刻意撤回 `占位符`（见 `charAnchors.ts:18-25` 的归因：一张图里出现三份完整外貌 → 多个重叠躯干）。**这是两条已经分岔并且各自有明确踩坑记录的路，不该互相移植。**

### 5.3 LoRA 挂载

`rules.js:155` `withLoraStrength` + `pipeline.js:859` `parseLoraSpec` 是「按角色位挂 LoRA」，柏宝绘是「按预设挂 LoRA」（`simple.loras`）。后者更简单、更可预期，且 `moss-anime` 线在插件侧本身就是 `bindings.lora: []`（焊死在模板里，`configs/moss-anime.md:41` 原文）。**这一项连插件自己都不用了，没有移植意义。**

### 5.4 分镜页版式

插件侧分镜页的权威写法是 `prompts/specs/moss-anime.md` §8（第 96-198 行，含格数表、四种页型照抄写法、每格三段式、跨格一致性、气泡规则）。柏宝绘已经有一条**不同的路**：`settings.ts:1651` `LayoutLock` 四档（`auto` / `single` / `strip` / `page`），由 `prompt.ts:349` `layoutRule` 动态追加进协议，再由 `layoutThinking`（`prompt.ts:450-458`）在思维链末尾要求「交之前数一遍：段数 = 1（页型）+ 格数 + 1（整页光）」。

差别在**判据归属**：插件把版式写成散文规范，柏宝绘把它做成**预设级开关**（「一旦让模型自己决定版式，同一段剧情会时单时多格」，`settings.ts:1648` 原文）。柏宝绘这条路更适合它自己的产品形态 —— 用户点按钮切版式，而不是靠写手每轮读规范判断。所以不该搬 §8 的散文，只该搬其中的**硬上限**（格数 ≤ 3/4，超过必崩），而这一条柏宝绘的 `layoutRule` 已经写进去了。

### 5.5 层序权重语义

`assemble.js:156` 那句「剖面永远最后（尾部权重最高）」成立的前提是底模读 tag 流、对位置敏感。柏宝绘当前主推的 MOSS 线吃的是**中文连贯散文**（`DEFAULT_MOSS_ANIME_SPEC` §三，`settings.ts:789-799`：4–5 段中文自然语言，段间空一行）。散文没有「尾部权重」这回事 —— 最后一段重要是因为它是画风层，不是因为位置偏置。**移植这条会得到一个看起来有道理、实际不生效的规则**，比不移植更坏。

---

## 6. 残留缺口与下一步

### 6.1 词表能判什么、不能判什么

`inspectFrame` 的判据全部是**词表 + 计数 + 静态容量表**：

- 能判：同一格里两个互斥景别（`size-conflict`）、正面与背面同时要求（`angle-conflict`）、景别人数超容（`size-crowded`）、景别纵深超层（`size-overlayered`）、正侧机位 + 贴身接触（`profile-occlusion`）、竖幅横排三人（`portrait-row`）、特写里塞两个人（`closeup-relationship`）。
- 不能判：**任何需要「看图」或「看剧情」才能判的东西**。典型如：
  - 「近景 + 全身裙摆拖地」—— 裙摆算不算出画，词表不知道；
  - 「两人相对而坐 + 正面机位」—— 正面能否同时框住两张脸，取决于座位间距，串里通常没写；
  - 中英混写时同一个景别出现两次（「中近景」+「medium close-up」）—— `harvest` 按 id 去重能抓，但「close shot」这种非标准写法抓不到。

### 6.2 现有 `inspectFrame` 的具体盲区（写清边界，不吹）

1. **只做「判定」，不做「求解」**。它回答「这组词自洽吗」，不回答「这一格应该用什么景别」。
2. **人数与接触度靠猜**。`countPeople`（`shotspec.ts:227`）只认「一个人 / 两个人 …」和 `(N) girls` 两种写法；`inferContact`（`shotspec.ts:198`）只认最硬的动词。猜不出就**不判**（`people` 为 `undefined` 时直接跳过 ③④⑥⑦）—— 这是刻意的保守，代价是漏判。
3. **容量表是拍摄常识的离散化，不是光学**。`SIZE_TABLE` 的 `capacity` / `layers` 是拍的脑袋，不是渲染参数。它够拦「中近景塞三个人」这种明显矛盾，不够判「四个人 + 远景在 832×1216 竖幅上是否还能辨认」。
4. **只读 `tag` / `nl` 两个字段**。柏宝绘的 `characters` 段、`size`（横竖）是分开传的；`orientation` 只有显式传进 `InspectOptions` 时 `portrait-row` 才会触发。
5. **尚未接线**。今天 `shotspec.ts` 在 `src/` 里是**孤岛**：grep 全项目，除自身外没有任何文件 import 它（`prompt.ts` 里还没有 `SHOT_ORDER_RULE` 的引用）。所以「移植」目前完成的是**判据层**，**协议注入层与调用层是 task-1 在做的部分**。

### 6.3 建议的下一步（可选，写清代价）

**把 `inspectFrame` 从「判定式」升级成「求解式」**：给定接触点（`contact`）与机位朝向（`angle`），反推**可行的景别集合**，而不是只对已写的景别打分。

- 输入：`{ contact, angle, people, orientation }`
- 输出：`{ feasibleSizes, blocked }`（每一项带原因）
- 用途：写串阶段反向生成「这一格该写什么景别」，以及 `inspectFrame` 报错时直接给替换项（现在 `fix` 是散文，升级后可以是枚举）。
- 代价：需要一张 `contact × angle → feasible sizes` 的二维表，而这张表**没有权威来源**，只能是拍摄常识的人工离散化 —— 与 `SIZE_TABLE` 同一种可信度。这会引入「表错了就系统性误判」的风险，且误判会集中在最常见的那几种接触上。**建议先跑一段时间的 `inspectFrame` 命中率统计再决定做不做**，不要凭「应该能行」就上。

另一个更便宜的方向：先把 `inspectFrame` 的 `code` 命中率记进现有告警通道（`prompt.ts` 的 `contentRule` 警告面），用真实数据决定要不要加判据 —— 这比继续猜词表靠谱。

### 6.4 落地状态一览

| 部分 | 状态 |
|---|---|
| 判据层（`parseShot` / `inspectFrame` / `blockingIssues` / 三张词表） | **已落地**，`src/autoTag/shotspec.ts`，纯函数、无 IO、不 import settings |
| 规则常量（`SHOT_ORDER_RULE` / `emitShotTag`） | **已落地**，等待被 `prompt.ts` import |
| 协议注入（`prompt.ts` 的 rules 数组插入） | **进行中**（task-1） |
| 调用层（产出后非阻断体检、降级 warn） | **进行中**（task-1），硬要求：不得让既有出图流程失败 |
| 单测（词表归并四条 + 判定四条 + 字段顺序 + `inferContact`） | **进行中**（task-1，`shotspec.test.ts`） |

---

## 附录 A：取证清单（文件 → 关键行 → 结论）

| 文件 | 关键位置 | 支撑的结论 |
|---|---|---|
| `lib/assemble.js` | `:70` `buildPrompt`、`:153-156` push 顺序、`:15` 第三条纪律、`:167` `ignoreString` | 只做层序拼接；不补词；层序合同在此 |
| `lib/pipeline.js` | `:614-630` 输入校验、`:733-768` 拼装、`:770-785` lint、`:805-828` 闸门 | 管线八阶段无构图步；`prompt` 原样透传 |
| `lib/promptdoc.js` | `:223` `analyzePromptText`、`:49-61` `SLOT_WORDS`、`:317-323` 槽位 info、`:64-86` `CODE_FIX` | 判据全在词表层；景别只做弱提示；**无段数/编号检查** |
| `lib/lint.js` | `:45` `lintBlockReasons`、`:209` `lintPrompt`、`:50-53` `skippedOut`、`:5-8` 纪律 1 | 闸门只转述外部脚本；fail-open；判据不读开关 |
| `lib/rules.js` | `:180` `parseIdentity`、`:251` `identityBlockText`、`:390` `detectIdentities`、`:603` `parseLibrary`、`:466` `identityLineMatches` | 形象块注入路径；档库解析；`line` 门禁 |
| `lib/guide.js` | `:45-51` `WRITING_POINTS` | 构图（机位）被明确划给写手 |
| `configs/moss-anime.md` | `:56-73` 画风层、`:41` `bindings.lora: []`、`:106` 档库缓存需重启 | 画风靠 LoRA + 固定串；层库不适用于本线 |
| `prompts/specs/moss-anime.md` | `:30-41` §2 骨架、`:96-198` §8 分镜页、`:200-209` §9 禁止项 | 构图纪律在散文里；「同一件事两层说」是禁止项 |
| `guards/char_block_guard.py` | `:13-20` 五条判据 | 插件真用的闸门判的是「外貌复述」，不是构图 |
| `src/autoTag/shotspec.ts` | `:56` `SIZE_TABLE`、`:142` `harvest`、`:163` `parseShot`、`:183` `emitShotTag`、`:198` `inferContact`、`:244` `inspectFrame`、`:347` `blockingIssues`、`:352` `SHOT_ORDER_RULE` | 项目侧 ②③ 的实现 |
| `src/autoTag/prompt.ts` | `:82` `autoTagProfile`、`:320-322` `contentRule`、`:349-356` `layoutRule`、`:450-458` `layoutThinking` | 三段协议；分工条款；版式锁接线方式 |
| `src/state/settings.ts` | `:765` `DEFAULT_MOSS_ANIME_SPEC`、`:893` `DEFAULT_MOSS_ANIME_THINKING`、`:1651` `LayoutLock`、`:1684` `activeLayoutLock` | 规范与思维链里的构图条款；版式锁单一真源 |
| `src/backends/comfyTemplates.ts` | `:398` `composePositive`、`:407` `composeNegative`、`:148` `MOSS_ANIME_DEFAULT_NEGATIVE`、`:234` `'moss-anime'` | 柏宝绘的拼接点；无层序语义；画风由预设 `positive` 承担 |
| `src/state/charTags.ts` | `:176` `buildEntryTag`、`:568` `chineseAppearanceForText` | 项目侧角色外貌路径（按名字认人） |
| `src/autoTag/protocol.ts` | `:174` `parseImagePlan` | 验收只判结构/位置/数量，不判内容 |

---

**一句话收尾**：插件没有构图能力，它只有「别拼坏」和「别写错」两条纪律；柏宝绘能接手的是这两条 —— 而真正要补的那块（散文不闭环、几何可行性判不了），仍然只能靠写串的人把机位想清楚，代码最多在他写矛盾时把他拦下来。

# 条件求值可抢占：26 码元即可冻死事件循环（#113 / REV-34）

- **原 issue**：[#113](https://github.com/zzjcool/pi-async/issues/113)
- **基线**：`main` `30adc70`（已含 #112 的 `docs/reports/redos-benchmark.md`）
- **交付分支**：`pi-subagent/piasync-113-preempt-1fd02167`（PR [#114](https://github.com/zzjcool/pi-async/pull/114)，
  正文 `Fixes #113`）
- **契约**：`docs/CONTRACT.md` §26（REV-34，冻结）+ §4 / §20.2 的因果改正
- **数字出处**：§2 与 §4 的测量值来自**同一次 canonical 运行**（附录 A 逐字），跑法见 §8。凡另一台机器/另一次
  运行的数字都注明了出处。

## 1. 结论

> `output_matches` 的求值**离开主线程**（worker thread，硬预算 **25 ms**，worker 复用、越界 terminate + 重建）。
> 修后对 26/30 码元的病态输入，**10 ms 定时器在 11–12 ms 触发**（修前 5013 / 12496 ms）；越预算的语义是
> **该轮裁决被放弃、按未命中处理**——不判失败、不 kill、不累计 `blind_checks`、不动 `timeoutMs`，计数器
> `matchBudgetExceeded` 进 `async_status` 与详情，每条任务只提示一次。15 行良性对照表的命中结果与 `main`
> **逐字相同**。两条要求的变异都红在**指名该验收条**的那条断言上。

| # | 验收（issue 原文） | 结果 | 证据 |
|---|---|---|---|
| 1 | 26 码元求值时 10 ms 定时器须在 200 ms 内触发（修前 3.12 s） | **通过**：11.5–12.3 ms | §2、`tests/w3-preemption.test.ts:37` |
| 2 | 同一轮 `async_status` 显示 `matchBudgetExceeded ≥ 1`，任务**不是** failed | **通过** | §3、`tests/w3-preemption.test.ts:142` |
| 3 | 良性模式结果逐字不变（含 64K 良性输入） | **通过**：15/15 行 verdict 相同 | §4 |
| 4 | `timeoutMs` / `intervalMs` 在挂住场景仍生效（修前被饿死） | **通过**：2 s 的 watch timeout 在 < 4.5 s 内结算 | `tests/w3-preemption.test.ts:186` |
| 5 | 变异 2 条必红 | **通过**：① 定时器断言红（5087 ms）；② "must never settle the task" 红 | §5 |
| 6 | 契约文本改动与 REV 条目单独可读 | 单独提交 `fe24dc6`（先于实现） | `git log` |
| 7 | `npm run typecheck` exit 0；`npm test` 与 main 基线逐条相同；CI 绿 | **通过**：499/470/16/13；失败集合与基线 `diff` 为空；CI 见 §6 | §6 |

## 2. 事件循环冻结：修前 / 修后的原始日志

同一台机器、同一个脚本（`scripts/watch-preemption-bench.mjs`）、同一个动作：**先上弦 10 ms 定时器，再对
`(a|a)*$` 的 26/30 码元主体求值**。`--tree` 指向被冻结的那个 checkout。

**修前（`main` `30adc70`）—— 逐字：**

```text
event-loop freeze demo: regex "(a|a)*$", 10 ms timer armed before the evaluation
code units  eval returned after            the 10 ms timer fired at         verdict
26          5012.88 ms (matched=true)     5013.03 ms after the arm         STALLED (> 200 ms)
30          12496.12 ms (matched=true)    12496.16 ms after the arm        STALLED (> 200 ms)
```

**修后（本分支）—— 逐字：**

```text
event-loop freeze demo: regex "(a|a)*$", 10 ms timer armed before the evaluation
code units  eval returned after            the 10 ms timer fired at         verdict
26          57.98 ms (matched=false)      12.27 ms after the arm           event loop stayed responsive
30          53.89 ms (matched=false)      11.49 ms after the arm           event loop stayed responsive
```

读法（三条都要看）：

- **定时器列才是验收 1**：修前 5013 / 12496 ms，修后 12.27 / 11.49 ms。修后这两个数**不随输入变难而增长**，
  因为它们只等一个 10 ms 定时器；求值本身被 25 ms 预算掐断。
- **求值列里含 worker 冷启动**：修后 26 码元 57.98 ms 里有约 30–45 ms 是**一次性**的线程启动（预算从消息
  投递才开始计时，见裁决 1）。这就是为什么"越预算 terminate 并重建"的代价是每轮一次性而不是每轮累积。
- **修前的 `matched=true` 是真的**：`(a|a)*$` 允许零次重复，穷举完指数条路径后在偏移 n 处以**零宽匹配**
  成功（#112 报告 §5（1））。所以修前不是"慢慢放弃"，是"冻住之后还会命中"；修后同样的输入返回 `false`
  —— 这是**裁决 2 的取舍**，文案与契约都写明"这一轮裁决被放弃，可能漏掉真命中"（§3、§7）。

## 3. 超预算语义的落点（裁决 2）

| 语义（issue 钉死的） | 落点 | 断言 |
|---|---|---|
| 该轮视为**未命中**，`pending` 照旧 | `src/core/watch.ts:345`（`budget` → `{status:"budget"}`）→ `:319`（计入 `budgetExceeded`，不参与 pending/error 判定） | `w3:60`（`status === "matched"`、`matched === false`） |
| **不累计** `blind_checks` | `src/core/watch.ts:260`（`noteBudget` 只回调计数）；盲计数分支在 `:249` 只看 `error` | `w3:142`（`blind_checks: 1` 下任务仍 `running`——越预算若被当 error 会立即 `blind_exhausted`） |
| **不动** `timeoutMs` / `intervalMs` | 预算只在求值内生效，`scheduleNext` 与 deadline 一字未改 | `w3:162`（`watchDeadline` 前后一致）、`w3:186`（2 s 到期仍如期结算） |
| **绝不**判失败 / kill | `src/core/registry.ts:737`（`noteMatchBudgetExceeded` 只加计数 + 一次性提示） | `w3:142`（`status`/`failureKind`）、`w3:225`（进程退出路径同样不判失败） |
| 每任务计数器进 `async_status` 与详情 | `src/core/task.ts:118` → `async_status`；`src/tui/panel.ts:109`（详情第二状态行） | `w3:176`（工具返回的 payload 里 `matchBudgetExceeded ≥ 2`）、`w3:181` |
| 每条任务**只提示一次** | 闩锁 `metadata.matchBudgetNotified`（`registry.ts:741`，随快照持久化）；发送 `async-watch-notice`（`notify.ts:213`，`followUp` + `triggerTurn:false`） | `w3:166`（跨 ≥2 轮恰好 1 条） |

**用户可见文案**（这是复核逼出来的一处修正）：提示与详情行说的是"**这一轮的裁决被放弃**"，不是"测量到未命中"：

- 提示（`src/core/notify.ts:102`）：`…exhausted its evaluation budget, so that round was abandoned and counts as
  no match. No verdict was reached: … a real match (success_when) or a real failure (failure_when) on such a
  round can be missed.`
- 详情（`src/tui/panel.ts:109`）：`output_matches: N abandoned verdicts (25 ms budget) · no verdict, not a failure`

理由：`(a|a)*$` 最终**会真的匹配**（#112 §5（1）），所以"按未命中处理"在 `success_when` 上可能一直不命中
（最后由 `timeoutMs` 终结），在 `failure_when` 上可能漏一次真失败。契约 §26 裁决 4b 把这个取舍写死了。

## 4. 良性对照表：与 `main` 逐字相同

同一脚本、同一台机器、两次运行（一次 `--tree /tmp/piasync-main-113`（= `origin/main` `30adc70`），一次本分支）。
每行**只求值一次**（两次运行都是），前面有一次性预热，所以行内耗时可比；`verdict` 是 `evalConditions` 的结果。

| case | 主体长度 | `main` verdict | 本分支 verdict | `main` 耗时 | 本分支耗时 | 本分支 `budgetExceeded` |
|---|---|---|---|---|---|---|
| control-64k-nomatch | 65536 | false | false | 0.06 ms | 0.13 ms | 0 |
| control-64k-match | 65541 | true | true | 0.02 ms | 0.14 ms | 0 |
| control-8k-nomatch | 8192 | false | false | 0.01 ms | 0.04 ms | 0 |
| control-1k-match | 1030 | true | true | 0.00 ms | 0.09 ms | 0 |
| multiline-anchor（`^(ready\|done)$`） | 16 | true | true | 0.12 ms | 0.12 ms | 0 |
| max-window-gapless（`(a\|a)*$`，无尾巴） | 65536 | true | true | 0.22 ms | 0.27 ms | 0 |
| max-window-gapless-1k | 1024 | true | true | 0.01 ms | 0.10 ms | 0 |
| word-boundary-64k（`ERROR\b`） | 65541 | true | true | 0.03 ms | 0.07 ms | 0 |
| line-anchor-64k（`^\[[0-9]+\] task`） | 65552 | true | true | 0.04 ms | 0.31 ms | 0 |
| tail-inside-window | 65558 | true | true | 0.31 ms | 0.04 ms | 0 |
| tail-outside-window（标记被 64K 窗口截掉） | 65568 | false | false | 0.02 ms | 0.04 ms | 0 |
| empty-subject（`^$`） | 0 | true | true | 0.02 ms | 0.03 ms | 0 |
| empty-subject-nomatch（`.`） | 0 | false | false | 0.01 ms | 0.03 ms | 0 |
| bounded-repeat-benign-1k（`(.*a){20}$`） | 1024 | false | false | 1.59 ms | 1.68 ms | 0 |
| bounded-repeat-64k-boundary（`(.*a){20}$`） | 65536 | false | false | **6418.97 ms** | **25.42 ms** | **1** |

**verdict 列 `diff` 为空**（脚本逐字对比）：

```text
diff <(main 的 case+verdict) <(branch 的 case+verdict)  →  VERDICTS IDENTICAL
```

两条要从表里读出来的东西：

1. **良性行逐字相同，且没有变慢**：所有 < 2 ms 的行两边都在微秒–毫秒级；本分支多出的 0.03–0.1 ms 是
   `postMessage` 一个往返（一次调用一次，不是每轮）。64K 良性输入（`ready|done`、`(a|a)*$` 无尾巴、
   `ERROR\b`、行锚）全部 `true/false` 与 main 一致。
2. **`bounded-repeat-64k-boundary` 是本报告额外发现**：`(.*a){20}$` 在 64K 良性主体上 main 要
   **6418.97 ms**（又一次证明 64K 不是防线——这是第四个能挂住宿主、又能过校验的形状），本分支在 25 ms
   处掐断。两边的 verdict 仍然都是 `false`，本分支记 1 次 burned budget。也就是说：**修后唯一与 main
   不同的可见行为，是"更早放弃一个本来要跑 6 秒的裁决"，而不是结果不同**。

## 5. 变异：两条要求的都红在"指名验收条"的断言上

做法：改源码 → 只跑 `tests/w3-preemption.test.ts` → 逐字取失败行 → 还原（`git status` 干净）。

### 变异 ①：去掉预算，回到同步求值（要求：验收 1 红）

`src/core/watch.ts` 的 `output_matches` 分支改回 `new RegExp(...).test(matchSubject(ctx.output))`：

```text
# tests 10 / pass 2 / fail 8
not ok 1 - #113 acceptance 1: a 10 ms timer fires within 200 ms while a 26/30-code-unit regex is evaluated
  error: 'the 10 ms timer was starved: it fired after 5087 ms while a 26-code-unit subject was evaluated'
```

**红的就是验收 1 自己的断言**（定时器被饿死 5087 ms），不是副产品。

### 变异 ②：把超预算当失败（要求：验收 2 红）

`src/core/registry.ts` 的 `noteMatchBudgetExceeded` 里加 `failureKind = "blind_exhausted"; finalize(task, "failed")`：

```text
# tests 10 / pass 7 / fail 3
not ok 5 - #113 acceptance 2: the task survives over-budget rounds — counter rises, status is not failed
  error: an over-budget round must never settle the task
    + actual - expected
    + 'failed'
    - 'running'
```

**红的就是验收 2 自己的断言**。

### 变异 ③（额外，因为复核抓到一个真缺陷）：退出路径不计入计数器

`src/core/registry.ts` 的进程退出路径原本用 `evalConditions`（丢弃 `budgetExceeded`），复核指出这与裁决 5
（退出路径同样走预算）+ 裁决 2（计数器是唯一记录）冲突。修好后补一条回归测试；把修复撤掉：

```text
not ok - #113 (REV-34 ruling 5): the process-exit evaluation credits the same counter, and is not a failure
  error: 'the exit-path evaluation must credit the per-task counter'
```

## 6. 测试与仓库健康

| 命令 | 本分支 | `origin/main` 同机基线 | 结论 |
|---|---|---|---|
| `npm run typecheck` | **exit 0**，无诊断 | exit 0 | 一致 |
| `npm test` | **499 tests / 470 pass / 16 fail / 13 skip** | **489 / 460 / 16 / 13** | 新增 10 例全绿；失败集合见下 |
| 失败**名单** `diff` | —— | —— | **空**（16 条逐条同名） |

那 16 条是这台 macOS 上本来就红的（realpath/`/var/folders` 越界判定、rail/hold 时序、`kill EPERM` flake、
`blind_exhausted` 与 `async_kill after watch timeout`、delayed/pending 取消），与 #112 报告记录的基线同类。
本报告**不声称 test 全绿**，只声称与基线**逐条相同**：

```text
diff main-fails.txt branch-fails.txt   →   无输出（16 / 16 同名）
```

**CI**（仓库只跑 ubuntu）：PR #114 的 checks —— `ci (node 22)`、`ci (node 24)`、`pi 1.5.0 compat`、`ci` 全绿。
本机 macOS 那 16 条在 ubuntu 上不存在，所以 CI 是"最终为准"的那一票。

## 7. 已知限制与刻意不做

- **越预算会漏判**（裁决 4b）：这是 issue 钉死的语义，不是缺陷。文案已经把它说清楚，并在 `README` /
  skill 里给了出路（`stdout_contains` 或收窄正则）。
- **worker 起不来**（平台/宿主限制）时，该轮记 `error` → 走既有 `blind_checks` 基础设施失败路径，并在 stderr
  打一行原因；不静默放行、不偷偷回退同步求值（那会复活本条要修的冻结）。
- **每轮把 ≤64K 码元主体 `postMessage` 给 worker** 是一次拷贝（≤128 KB），量级微秒；不共享 `SharedArrayBuffer`
  （复杂度不值得）。
- **`readWatchOutput` 每轮同步读 8 MiB 尾部**自身的停顿不在本条范围（REV-25 已给它单独的界）。
- **不做**：换正则引擎（RE2/PCRE）、静态分析判"会不会爆"（黑名单已被证明只能当深度防御）、缩小
  `MAX_MATCH_CHARS`（#112 已论证要缩到 ~16 字符才安全，那会让条件失去用途）。
- **`(a|a)*$` 仍能过校验**：有意的（见裁决 4）。将来收紧黑名单必须同时换掉 w3 的量具。

## 8. 复现

```bash
# 冻结 demo + 良性对照表（本分支）
timeout 120 node --experimental-strip-types scripts/watch-preemption-bench.mjs
# 与另一个 checkout 对拍（把 main 的树解开到 /tmp/piasync-main）
git -C <repo> archive origin/main | tar -x -C /tmp/piasync-main
timeout 300 node --experimental-strip-types scripts/watch-preemption-bench.mjs --tree /tmp/piasync-main
# 只看验收 1/2/4 的测试
timeout 300 node --experimental-strip-types --test tests/w3-preemption.test.ts
```

`--demo` / `--parity` 可单跑一张表，`--json` 输出机器可读结果（含每行的 `budgetExceeded`）。

### 8.1 一个必须写明的坑（它影响过本报告的测试设计）

`(a|a)*$` **匹配空串**（零宽）。所以"先 `sleep` 再打印病态主体"的测试里，任何一次在输出出现之前的 tick 都
会**立刻命中**并结算 watch。写"退出路径"那条回归测试时踩到了它，改用 `(.*a){20}$`（对空串快速失败、对
26 码元要 ~880 ms）才把两件事分开。这不是本次改动的缺陷，但它决定了量具怎么选，记在这里免得下一个人再踩。

### 8.2 宿主加载器下的 worker 入口（复核提的潜在 blocker，已实测）

pi 用 jiti 加载 `extensions/index.ts`，所以 `new Worker(new URL(import.meta.url))` 在 jiti 下的行为需要实测，
不能靠"原生 strip-types 能跑"推断。实测（jiti 2.7.0 + node 22.22.3）：

```text
import.meta.url = file:///tmp/jt/mod.ts
worker said {"ready":true}
worker said {"echo":"ping"}
```

即：jiti 下 `import.meta.url` 是**源文件的真实路径**，worker 能起来、能收发消息（子线程用 node 自带的类型
剥离加载 `.ts`；`engines` 下限 22.19.0 已默认开启）。残余假设只有一条：宿主 node ≥ 22.19（那是本项目声明的
下限），若某天低于它，worker 起不来会走 §7 的 `error`/blind 路径而**不是**静默放行。

## 9. 对抗式复核（fresh context）与处置

三个独立只读 reviewer（正确性/回归、测试覆盖与验收、简洁性与契约可读性）。第三个跑完后给出 1 blocker +
9 major + 8 minor；前两个的宿主连接在跑的过程中被 provider 反复 `ECONNRESET`（子进程空转，已强制回收，
没有产出）。所以下面这份处置表**只覆盖一个 reviewer 的完整清单**——这是本次复核的诚实边界。

| # | 级别 | 发现 | 处置 |
|---|---|---|---|
| B1 | blocker | 契约/CHANGELOG 引用的 `docs/reports/watch-preemption.md` 尚不存在 | **本文件**；三处指针现在都有了落点 |
| M2 | major | 退出路径的预算**不计入**计数器（与裁决 5 冲突） | 已修（`registry.ts:475` 改走 `evaluateConditionsDetailed` 并计数）+ 新增回归测试（变异 ③） |
| M3 | major | 详情的第二状态行破坏 §21.1/§24 冻结的「header = 2 行」 | **改契约而不是偷偷破坏**：§21.1 / §24 的 header 改成「1–2 行（REV-34）」，并在 §26 影响面里写明视口少一行 |
| M4 | major | 新措辞「影响面与窗口大小无关」被自己的证据反驳（代价确实随长度涨） | 已改为「窗口给代价封顶，但封顶值在 16 码元就贴预算，所以既不是防线也不是可接受的上界」 |
| M5 | major | 文案把"被放弃的裁决"说成"测量到未命中" | 已改（`abandoned verdict` / `no verdict`），并新增裁决 4b |
| M6 | major | §26 缺 §16 强制的「影响面」段；新消息类型/新快照字段未定性 | 已补：影响面段（含"新增可选字段 = 非破坏"的判定、`async-watch-notice` 的投递语义、`metadata` 新键、内部 API 变异步） |
| M7 | major | 裁决 4 说"可以收紧黑名单"，而 w3 的量具正是 `(a|a)*$` | 裁决 4 改为：今天**有意**放行这三个形状（它们是 #113 的靶子），将来收紧必须同时换量具 |
| M8 | major | 死代码：`disposeRegexWorker` / `regexWorkerAlive` / `budgetMs` 形参 / `sendMatchBudgetNotice` 的无用 `registry` 形参 | 全部删除（约 25 行）；`MATCH_BUDGET_MS` 移到 `watch.ts`（TUI 不再把 `worker_threads` 拉进模块图） |
| M9 | major | 裁决 3（64K 理由）/裁决 5（await 后复检）**无测试** | 各补一条：契约漂移守卫（`CONTRACT.md` 不得再出现「限制 ReDoS 影响面/作用面」）、"stop() 落在 await 中时空转"测试 |
| m10–m13 | minor | 自指行号失效、悬空 "REV-R3 见下"、README 把主体长度写成正则长度、CHANGELOG 引了不存在的中文文案 | 全部改掉 |
| m14 | minor | 历史 CHANGELOG（0.2.0）仍把 64K 与 ReDoS 并列 | **不改**（历史记录不改写；当前源码/README/skill/契约已全干净） |
| m15 | minor | `MATCH_BUDGET_MS` 定义在 worker 模块却被 TUI/notify 导入 | 已移到 `src/core/watch.ts` |
| m16 | minor | `checking` 守卫会把并发 tick 丢掉（当前调用图不可达） | 保留（防重入是异步化的必要条件）并加注释说明；新增"stop 落在 await 中"测试覆盖其实际后果 |
| m17 | minor | `logOnce` 一次失败后永久静音 | 已修：worker 成功 ready 时复位闩锁，后来的**新**失败仍会报 |

未采纳的建议（并说明理由）：

- **"把计数器塞进 metadata、删掉详情第二行"**：会让计数器在短终端里被折进 `… (+K lines)`，而 issue 要求它
  在**详情**里可读。改为显式修订 §21.1/§24 —— 冻结条款该被显式修订，而不是绕开它。
- **"内核 worker 换成内联字符串脚本"**：能消除 `import.meta.url` 的加载器风险，但会把 20 行脚本变成不可
  类型检查的字符串。§8.2 已实测 jiti 路径正常，风险不足以付这个代价。

## 附录 A：canonical 运行的原始 stdout（逐字）

本分支（`--tree` 默认，即本 worktree）：

```text
event-loop freeze demo: regex "(a|a)*$", 10 ms timer armed before the evaluation
code units  eval returned after            the 10 ms timer fired at         verdict
26          57.98 ms (matched=false)      12.27 ms after the arm           event loop stayed responsive
30          53.89 ms (matched=false)      11.49 ms after the arm           event loop stayed responsive

benign parity matrix: 15 rows, MAX_MATCH_CHARS = 65536 (subject cap of the tree under test)
case                        subject chars  matched  eval time     budget-exceeded
control-64k-nomatch                 65536  false    0.13 ms        0
control-64k-match                   65541  true     0.14 ms        0
control-8k-nomatch                   8192  false    0.04 ms        0
control-1k-match                     1030  true     0.09 ms        0
multiline-anchor                       16  true     0.12 ms        0
max-window-gapless                  65536  true     0.27 ms        0
max-window-gapless-1k                1024  true     0.10 ms        0
word-boundary-64k                   65541  true     0.07 ms        0
line-anchor-64k                     65552  true     0.31 ms        0
tail-inside-window                  65558  true     0.04 ms        0
tail-outside-window                 65568  false    0.04 ms        0
empty-subject                           0  true     0.03 ms        0
empty-subject-nomatch                   0  false    0.03 ms        0
bounded-repeat-benign-1k             1024  false    1.68 ms        0
bounded-repeat-64k-boundary         65536  false    25.42 ms       1
```

`origin/main` `30adc70`（`--tree /tmp/piasync-main-113`）：

```text
event-loop freeze demo: regex "(a|a)*$", 10 ms timer armed before the evaluation
code units  eval returned after            the 10 ms timer fired at         verdict
26          5012.88 ms (matched=true)     5013.03 ms after the arm         STALLED (> 200 ms)
30          12496.12 ms (matched=true)    12496.16 ms after the arm        STALLED (> 200 ms)

benign parity matrix: 15 rows, MAX_MATCH_CHARS = 65536 (subject cap of the tree under test)
case                        subject chars  matched  eval time     budget-exceeded
control-64k-nomatch                 65536  false    0.06 ms        0
control-64k-match                   65541  true     0.02 ms        0
control-8k-nomatch                   8192  false    0.01 ms        0
control-1k-match                     1030  true     0.00 ms        0
multiline-anchor                       16  true     0.12 ms        0
max-window-gapless                  65536  true     0.22 ms        0
max-window-gapless-1k                1024  true     0.01 ms        0
word-boundary-64k                   65541  true     0.03 ms        0
line-anchor-64k                     65552  true     0.04 ms        0
tail-inside-window                  65558  true     0.31 ms        0
tail-outside-window                 65568  false    0.02 ms        0
empty-subject                           0  true     0.02 ms        0
empty-subject-nomatch                   0  false    0.01 ms        0
bounded-repeat-benign-1k             1024  false    1.59 ms        0
bounded-repeat-64k-boundary         65536  false    6418.97 ms     0
```

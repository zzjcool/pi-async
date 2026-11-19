# 守卫缺口收口（#105 的 3 处实现/文档不一致 + 1 处守卫盲区）— 交付报告

- Issue：zzjcool/pi-async#107（**Fixes #107**；条目原样来自 PR #105 报告 `docs/reports/contract-cleanup.md` §2）
- PR：zzjcool/pi-async#108
- 分支：`fix/guard-gaps`（worktree 分支 `pi-subagent/pi-async-inconsistencies-6ab404ba`，同一 commit）
- 基线：`origin/main` @ `d0407d1`（`git fetch` 确认相对开工点 `985a083` 前进：#105 / #104 / #101 / #102 已合入；worktree `reset --hard` 到该 commit 后开工）
- 范围：**只做任务卡四件事**。未改工具 schema、spawn/TUI 行为、版本号；`src/` 的行为改动只有 activity 上报路径（下一节）。

## 1) settle-guard 的私有 activity 副本 → 单一 bus 实现

### 改了什么

- `src/guard/settle-guard.ts`
  - 删除私有 `reportActivity()`（原 `:217-230`），改从 `src/core/bus.ts` import `reportActivity`。
  - `beforeSettle` 拆成纯判定 `decideBeforeSettle(active, event)` + 包装：先上报、答完当前 settle
    边界，再决定是否 `dispose()`。这样 `setActivity` 抛错**不会改变**提醒/advisory 的产生。
  - `register()` 末尾的上报同样走 bus；宿主拒写时 `dispose()`。
- `src/core/bus.ts`
  - `reportActivity` 加 `try/catch`，返回 `boolean`：`true` = 已上报或宿主无此 API（无 API 不算失败），
    `false` = 宿主拒写（stale ctx）。异常不再逃逸；TUI/扩展调用点忽略返回值，行为不变。
- `docs/CONTRACT.md` §7：原文写「四处特性检测 + 已知实现分叉（settle-guard 私有副本）」；实现收敛后
  这段话会变成**新的**文档不一致，故同步改为「三处 shim + 守卫走同一实现」（属于任务 1，不是额外重构）。

### 文案选了哪个、为什么

选 **bus 的字面量 `N async tasks`（恒复数）**，删掉 guard 的单数化分支（`1 async task`）。

理由：bus 是共享实现，调用点有 3 处（`src/tui/status.ts:122`、`extensions/index.ts:331,411`）+ 守卫；
选 bus 字面量只改守卫 `count == 1` 这一条路径（对应 2 个测试），选守卫的单数文案则要改 bus 的
formatter，波及 TUI/扩展的 3 个调用点——同样的「一处实现」目标，blast radius 更大。代价是
`1 async tasks` 的语法瑕疵（#16 此前的单数化被统一掉）；它不承载任何语义，记录为已知 cosmetic。

### stale-ctx 自愈没有丢

0.3.2 的修复（「`reportActivity` 读到 stale ctx 异常即 `dispose()` 自身」）保留：bus 把异常转成
`false`，守卫**先答完边界**再 `dispose()`。比原实现更强：旧实现异常时直接 return，连当次提醒都
不发；新实现让 settled 判定与 activity 彻底解耦。

### 单测

- ① `tests/a-settle-guard.test.ts` — `settle guard reports through the bus wording: one implementation, one literal`：
  fake `ui.setActivity`，断言 `register()` 上报 1 次、`agent_before_settle` 再上报 1 次，文案分别是
  `1 async tasks` / `2 async tasks`。
- ①（结构）`settle-guard keeps no private activity copy; the bus shim is the only writer (§7 / #105)`：
  源码不含 `.setActivity(`，且 import 的是 `../core/bus.ts` 的 `reportActivity`。
- ② `a throwing setActivity cannot change the settle decision; the stale generation detaches after answering`：
  宿主拒写后提醒仍带 `continue: true`，然后 4 个 handler 全部退订（0.3.2 自愈）。
- `tests/a-bus.test.ts`：返回值三态（上报 `true` / 无 API `true` / 拒写且不抛、返回 `false`）。
- `tests/w2-safety.test.ts` 的 `#16` 用例改名为「uses the shared bus wording」，断言从 `1 async task`
  改为 `1 async tasks`（这正是 #105 §2.2 记录的「两份测试分别钉死两种文案」，收敛必须一起改）。

### 变异（修前红）

```
git checkout HEAD -- src/guard/settle-guard.ts   # 恢复私有副本
node --experimental-strip-types --test tests/a-settle-guard.test.ts
→ not ok 3  settle guard reports through the bus wording: one implementation, one literal
→ not ok 4  settle-guard keeps no private activity copy; the bus shim is the only writer (§7 / #105)
→ not ok 5  a throwing setActivity cannot change the settle decision; the stale generation detaches after answering
# pass 4 / # fail 3
```

恢复收敛实现后同文件 **7/7 绿**。

## 2) 漂移门扩到 §18（含 §18.11）+ 下限断言

### 改了什么

`tests/f-reminder.test.ts` 把原来的「只 `slice("## 17.", "## 18.")`」守卫换成
`scanToolSurfaceContract(contract)`：

- 扫 **§17 + §18** 两段（§18 slice 到 `## 19.`），返回 `{ sections, checks, findings }`。
- §17：3 项检查（不得出现 `6 个工具`；必须有 `5 个工具`；必须写 `PI_ASYNC_EXPOSE_WAIT`）。
- §18：必须保留 `### 18.11`，且 §18.11（slice 到 `### 18.12`）必须含
  `暴露 async_wait 时 6 个`（REV-29 第 6 席）。
- **下限断言**：主测试断言 `sections` 恰为 `["§17","§18"]`，且 `checks >= MIN_TOOL_SURFACE_CHECKS (5)`。
  段丢失/切片失效会让 findings 非空或 checks 掉到 5 以下，**不会**因为「文本里出现过 18」而空转通过。
- 自测 4 条：
  - §18.11 的 `时 6 个` → `时 5 个` → 红（finding 精确点名 §18.11）；
  - §17 的 `默认 5 个工具` → `默认 6 个工具` → 红（证明旧覆盖没被扩围时弄丢）；
  - 删掉 §18 的文本 → findings 报缺段、`sections` 不含 §18、`checks < 5`（反空转下限）；
  - 三条自测都先 `assert.notEqual(mutated, contract)`，防止「没改成也算红」。

### 修前红 / 修后绿

- **旧门（HEAD 版本）对同一漂移文本 13/13 通过** = 盲区复现：把 CONTRACT §18.11 的 `时 6 个` 做单点
  替换为 `时 5 个`（`git diff` 只有这一行），旧门 `# Subtest: §18.11 docs…` → `ok 10`、`# fail 0`。
- **新门对同一文本红**：`not ok 10 … §18.11 must keep the sixth seat (暴露 async_wait 时 6 个)`。
- 恢复 CONTRACT 后 `tests/f-reminder.test.ts` **16/16 绿**。

## 3) `CHANGELOG.md` 历史可见性措辞

- 位置：`CHANGELOG.md:709-710`（任务卡写 `673-674` 是 #102/#106 合入前的行号，行号漂移已在 #105 报告
  出现过同类问题）。
- 旧：`` （REV-8）。OSC 7501 / legion viz 侧可见。``
- 新：

  ```
  （REV-8）。这是 **id 形状约束，不是可见性承诺**：写入唯一走宿主的 `ui.setActivity`
  （feature-detect；官方 pi 1.2–1.5 无该 API 时是 no-op），本仓库不自行发 OSC 转义，
  legion 侧要等上游 #156 的转发通道。
  ```

### 等价证据（不是「改到能过」）

旧断言的三个子句逐个可证伪，且今天都不成立：

1. **「OSC 7501 可见」没有生产者**：`grep -rn "7501\|OSC" src extensions` 只命中 `src/core/output.ts`
   的转义剥离说明、`src/core/bus.ts` 的「never emit terminal OSC/printf escapes」、`src/guard/hold.ts`
   里对宿主 OSC 状态的**描述**；没有任何代码发 OSC 7501。
2. **「legion viz 侧可见」没有传输通道**：`src/core/bus.ts:12` 自己标注 per-task id 是
   「legion #156 / osc-busy-plugin」的**形状**目标；CONTRACT §7 的 RPC 段写明依赖上游 #156 的
   `extension_activity` 转发，未落地前 activity 字段恒缺。
3. **`ui.setActivity` 在官方 pi 1.2–1.5 不存在**：`src/core/bus.ts` 三个 shim 都 feature-detect。

因此把「可见」降级为「形状约束、不是可见性承诺」；这是 #105 §2.4 留下的判断（引不到具体行为就降级），
不是新增承诺。prose-only，无测试可红——用上面的 grep/代码证据作为等价证据。

## 验证

基线（`origin/main` @ `d0407d1`，本机 macOS）：

```
npm run typecheck   # pass
npm test            # tests 474 / pass 445 / fail 16 / skipped 13
```

改动后：

```
npm run typecheck   # pass
npm test            # tests 480 / pass 451 / fail 16 / skipped 13
```

- 新增 6 条测试（a-bus +1、a-settle-guard +2、f-reminder +3），**没有删除/跳过任何既有测试**。
- **失败集合逐条相同**（16 条，均为本机 macOS 的既存环境失败；CI 是 Ubuntu）：
  `/var/folders` vs `/private/var` realpath 导致 `assertInsideDataDir` 拒绝 6 条；`kill EPERM` 1 条；
  hold/rail 时序 8 条；`tests/g-revive-after-suspend.test.ts` 文件级 1 条（tmp 文件 ENOENT 竞态）。
- 13 条 skip 全部是既有的 `# SKIP needs /proc process-group probing (CI is ubuntu)`，未新增 skip，
  无 `SKIPPED:` 行。
- 失败数 16 → 16、skip 13 → 13、pass +6 = 新增测试数；**无回归**。

## 变异矩阵

| # | 变异 | 期望 | 实测 |
|---|---|---|---|
| 1 | 恢复 settle-guard 私有 `reportActivity` 副本 | a-settle-guard 红 | 3 fail / 4 pass（文案、结构、抛错三条） |
| 2a | CONTRACT §18.11 `时 6 个` → `时 5 个`，跑旧门 | **旧门漏检（应为绿）** | 旧门 13/13 pass（盲区复现） |
| 2b | 同一文本，跑新门 | 红 | 1 fail，finding 点名 §18.11 |
| 3 | CHANGELOG 旧措辞 | prose-only，无测试 | 用「无 OSC 生产者 / 依赖 #156 / feature-detect」三条代码证据替代 |

## 变更文件

```
 CHANGELOG.md                 |   4 +-
 docs/CONTRACT.md             |  21 +++---      # §7：实现收敛 + 三处 shim
 docs/reports/pi-async-guard-gaps.md            # 本文件
 src/core/bus.ts              |  30 +++++---
 src/guard/settle-guard.ts    |  39 ++++----
 tests/a-bus.test.ts          |  19 ++++-
 tests/a-settle-guard.test.ts |  55 +++++++++++-
 tests/f-reminder.test.ts     | 101 ++++++++++++++++++++-
 tests/w2-safety.test.ts      |   9 +-
```

没有 `git add -A`；`node_modules/`（typecheck 需要）被 `.gitignore` 覆盖，未入库。

## 未做 / 后续

- `raiseTaskActivity` / `clearTaskActivity` 仍未加 `try/catch`：不在四件事内。stale ctx 下它们仍可能从
  扩展回调逃逸（与本次收敛的聚合路径不同源），建议另开 issue。
- `1 async tasks` 的语法瑕疵：若想修，应在 bus 一处改成单复数 helper；那会改 3 个共享调用点在
  `count == 1` 时的文案，属于独立变更。
- 0.5.2 的 `[Unreleased]` 段未加条目：该段叙事是 #102 存储生命周期；本次用户可见变化只有单任务
  activity 文案，已在报告记录。

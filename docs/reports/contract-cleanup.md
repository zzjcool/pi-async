# #100 契约/文档收口 — 交付报告

- Issue：zzjcool/pi-async#100（**Fixes #100**）
- PR：zzjcool/pi-async#105
- 分支：`fix/contract-cleanup-100`（worktree `pi-subagent/host-workspace/pi-async-100d-db3c3a44`，同一 commit）
- 基线：`origin/main` @ `2344449`（`git fetch` 成功确认前进；本地分支 fast-forward 到该 commit 后开工）
- 性质：纯文档/注释/契约文本，零行为变更；未改任何工具 schema、spawn/TUI 行为

本报告覆盖任务卡的四条（G1–G4）。同一 issue 的 G5（`R` rerun 的 env 语义）也一并收口，否则
`Fixes #100` 会在 `:461` 验收项未完成时关闭 issue；G5 只加了两处文字，无实现改动。

## 1. 四条各写了什么判据

### G1 — POSIX-only 声明

**判据（可直接引用）**：平台支持范围 = Linux + macOS；**Windows 未支持/未验证**；CI 只跑 Ubuntu。
判定依据是三条热路径硬依赖：`/bin/sh -c` + `detached` 进程组（`src/core/spawn.ts:80`）、负 pid
进程组信号（`spawn.ts:226,230`）、`/proc/<pid>/stat` 判活（`spawn.ts:198-201`、`registry.ts:1374-1377`）。
`/proc` 是可降级层（缺失时退到 `kill(-pid, 0)`，只失去「僵尸组不算活」的精度）；不可降级的是
shell 与进程组信号。

落点：

- `README.md:27-30`（Install 段）：`POSIX-only` 声明 + Linux/macOS + macOS 的 `/proc` 退化 +
  `Windows is not supported or tested`。
- `README.md:288-290`（Known limitations 第一条）：同样的边界，补「WSL 的 Linux 侧 = Linux 环境」
  与「CI 无 Windows/macOS runner」。
- `docs/CONTRACT.md:663-667`（§12 工程约束）：三条硬依赖 + `/proc` 退化 + 平台边界 + CI 证据；
  并按 issue 要求写明**不加** `package.json` 的 `os`（npm 拒装属行为变更，需 REV）。
- 顺带把 `docs/CONTRACT.md:532`（§10）的描述性括注「detached 进程组 spawn（POSIX）」升级为
  「POSIX only，平台边界见 §12」，避免它是全仓唯一平台字样却不构成声明。

> 任务卡说「改正暗示 Windows 可用的措辞」：实测没有这类措辞——`README.md` / `package.json` /
> `CONTRIBUTING.md` 对 `windows|wsl|posix|linux|macos|darwin` 全部零命中。缺口是**该说的没说**，
> 不是写错。`package.json` 也无 `os`/`cpu` 字段（符合 issue 的「不要加」）。

### G2 — `async_wait` 的 generation 边界

**判据（三件事，可直接引用）**：

1. waiter 属于**发起它的 registry 实例**；每次 `async_wait` 由 `configure(ctx)` + `resolveRegistry()`
   解析当前活代。仓库没有跨代 epoch/token，代边界 = 实例边界。
2. `/reload` 即丢：`suspend()` 调 `waiters.clear()`（`registry.ts:966-967`，注释原文
   “Pending waiters belong to the retired generation; never wake them with stale results.”）。在飞的
   wait **不以失败收场、也不 kill 任务**：它靠自身 `timeoutMs` 到点，按该实例内存快照返回
   `{ notReady: [{taskId, status: "running"|"pending", elapsedMs}] }`，`isError=false`。
3. 跨进程无共享 waiter（不落盘、无 IPC/socket/`fs.watch`）；结果事实在
   `<dataDir>/<taskId>.json` 与输出文件，新代 `reloadFromDisk()` 后可用
   `async_status` / `async_logs` 取回。**要跨代/跨进程收割，用状态工具，不要等 waiter。**

落点：

- `docs/CONTRACT.md:207-227`（§5 新增「代际边界（#100，判据）」段）：三条 + 逐条 file:line 证据
  （`registry.ts:60,131`、`:1258,:1263`、`:966-967`、`:951-952`、`:708-717`、`tools/index.ts:326-327,334`、
  `tests/d-reload.test.ts:150`），并注明宿主主动 abort 时走 `Wait aborted` reject（`:718`），
  pi-async 自己不 abort。
- 同段末尾登记一个**例外**（不改变判据）：退役实例被自己的 `configure()` 复活（REV-28a）且磁盘真相
  在孤儿 waiter 到期前已终态时，会返回 `{ results, notReady: [] }`（timeout 分支读 `this.tasks`
  当前内容，`:711-716`）。
- `README.md:54-58`：一行用户面判据 + 指向 CONTRACT §5。

### G3 — activity 措辞

**判据（能/不能表达什么）**：

- **能**：一次 write-only 的 `(id, { message: string } | undefined)` 调用；两个 id（聚合 `"pi-async"`、
  每任务 `plugin/pi-async/<task-id>`）；清除 = `undefined`。没有 idle/working 枚举，没有结构化字段。
- **不能**：不能读回（仓库无 getActivity，activity 不进模型上下文）、不能表达每任务进度/耗时/优先级、
  **不能证明「真的在干活」或「没有工具在飞」**。legion 跨机侧今天没有转发通道（依赖上游 #156 的
  `extension_activity`），该侧字段恒缺/恒错；**任何消费者不得把 activity 的有无当作工作证据**。
  外部唯一诚实的 busy 信号是 settle hold 不结束 run（OSC 7501 保持 `working`）。
- **能力口径**：feature-detect shim，官方 pi 1.2–1.5 无 `ui.setActivity`；生产上是 no-op。
  每任务 id / raise / clear 降级为「shim 形状（上游落地后才生效），不是已实现能力」；REV-8 的
  `plugin/` 前缀裁决保留（它是形状约束，不是能力承诺）。
- **处数修正**：任务卡与旧契约写「三处特性检测」，实际是**四处**：`src/core/bus.ts:15,26,34` +
  `src/guard/settle-guard.ts:222`。契约已按四处写。

落点：

- `docs/CONTRACT.md:284-310`（§7）：能力口径 + 能/不能 + shim 形状（保留 REV-8）+ 已知实现分叉。
- `docs/CONTRACT.md:309-310`：RPC（legion child）段补「因此 RPC/跨机侧没有可用的 activity 证据」。
- `src/core/bus.ts:3-7`：文件头注释写明 write-only、不可回读、缺失 ≠ 空闲、当前 pi 无此 API、
  不得当作 work-in-flight 信号。
- `README.md` / `skills/` 保持对 activity **零承诺**（与旧契约一致，符合「README/CHANGELOG 不得写成
  已实现能力」）。

### G4 — 工具面 REV 条文

**判据（变更规则 + 破坏性定义）**：

- 工具面是**冻结契约**。增/删/改名/改默认注册面必须：新增 CONTRACT REV 段（原因 / 影响面 / 回退开关，
  格式同 §16）+ 验收清单 + CHANGELOG 段 + 迁移说明，并同步 `tests/k-toolsurface.test.ts` 与 §17 的
  snippet 清单。
- **破坏性判据**（任一命中即按破坏性处理，必须给迁移说明）：删除或改名工具；修改已有参数的类型/
  必填性/默认值；修改返回 payload 字段或 `isError` 语义；改变默认注册面（可选工具转默认、收紧或
  更换 env 开关、改默认工具数量）。纯新增且默认不注册的工具仍需 REV，但可标注「非破坏」。
- **席位**：第 6 席已被 `async_wait`（仅 `PI_ASYNC_EXPOSE_WAIT=1` 暴露）占用；新增 list/attach 工具
  实际是第 7 个，或顶掉 `async_wait`，不是「用空位」。

落点：

- `CONTRIBUTING.md:9-26`（新增 `## Tool surface changes`）：上述规则 + 席位说明。
- `docs/CONTRACT.md:668-674`（§12 新增「工具面是冻结契约（#100）」）：同上，中文版。
- `docs/CONTRACT.md:115-117`（§3 工具列表）：加一句指到 §12，避免规则只活在工程约束里。
- `docs/CONTRACT.md:1034-1035`（§18.11 末条）：把「§3 的『工具集（6 个）』」改成「默认 5 个 + 可选 1 个
  （REV-29：暴露 `async_wait` 时 6 个）」。全仓已无 `工具集（6 个）` / `6 个工具` 命中。

### G5 — `R` rerun 的 env 语义（同一 issue 的第五条）

**判据**：`R` 的 cwd = **原任务** cwd（REV-13）；env **不复刻**——快照不存 env（`TaskSnapshot` 无该
字段），rerun 只传 `command` / `name` / `mode` / `cwd`（`src/tui/panel.ts:532-537`），子进程拿**当前**
`process.env` + 当前 `PI_ASYNC_ENV_INHERIT` 策略（`src/core/spawn.ts:78`）；`watch` / `taskTimeoutMs` /
`notifyOnCompletion` / `triggerOnCompletion` 同样不复制。

落点：

- `docs/CONTRACT.md:498-501`（§8 面板段）。
- `README.md:107`（`R` 行，一行内含三条）。

## 2. 实现与文档不一致（只记录，未改实现）

1. **activity 有第 4 份私有实现，且文案与 bus 不同**：`src/guard/settle-guard.ts:217-230` 不 import
   `src/core/bus.ts`，自己拼 `"pi-async"` id；`total === 1` 时输出 `1 async task`，bus 恒复数
   （`1 async tasks`）。同一聚合 id 两个写入者，交替上报时文案会跳变。另有鲁棒性差异：guard 副本有
   try/catch + stale-ctx `dispose()`，bus 的三个函数没有（`pi.ui` getter 抛错会直接逃逸）。
   **未改**：收敛实现需要改代码，超出本次「只改文档/注释」范围。建议另开 issue：共享 id 常量与
   文案格式化，或让 guard 调 `${count} async task${...}` 的统一 helper。
2. **两份测试分别钉死了两种文案**：`tests/a-bus.test.ts:10` 断言 `3 async tasks`（复数路径），
   `tests/w2-safety.test.ts:364` / `tests/a-settle-guard.test.ts:78` 断言 `1 async task`（单数路径）。
   即分叉被测试双向冻结，改实现时必须同时改两处。
3. **漂移门覆盖不到 §18.11**：`tests/f-reminder.test.ts:404-413` 只 `slice("## 17.", "## 18.")`，
   且谓词是 `/6 个工具/`，与旧文「工具集（6 个）」不同形（`个` 后是 `）` 不是 `工具`）。本次只修了
   文档；测试未改（任务卡要求只改文档/注释/契约）。建议后续把漂移门扩到全文或 §18.11，并同步正则。
4. **`CHANGELOG.md:673-674` 的历史承诺**：per-task activity id 变更条目写「OSC 7501 / legion viz
   侧可见」。在官方 pi 无 `ui.setActivity` 的今天该可见性不成立。未改历史条目，仅在此记录。
5. **`docs/CONTRACT.md:557` 把 activity 当真实 UI 推理**：§10 的「宿主 per-task activity 幽灵
   spinner」（reload 回填段）假设该元素存在。它是条件式推理（宿主将来支持时才成立），未改。
6. **`elapsedMs` 语义此前未文档化**：notReady 的 `elapsedMs` = `Date.now() - createdAt`（任务创建至今），
   不是本次等待时长。本次已随判据写入 §5；无实现改动。
7. **任务卡前提修正**：「三处 feature-detect」实为四处（见 G3）；「`docs/CONTRACT.md:980`」在
   当前 `main` 上是 `:983`（`#101/#104` 合入后行号漂移），现已修为 `:1034-1035` 的新文案。

## 3. 验证

基线 `origin/main` @ `2344449`：`npm run typecheck` 通过；`npm test` **441 tests / 441 pass / 0 fail /
0 skipped**。本次改动后（文档 + 1 个文件头注释）复跑结果相同：**441 pass / 0 fail / 0 skip**，
无 `SKIPPED:` 行（没有跳过任何测试），数目未降。

```
npm run typecheck   # tsc --noEmit，通过
npm test            # tests 441, pass 441, fail 0, skipped 0
```

issue 验收命令的实际结果：

- `rg -n -i 'posix|windows' README.md docs/CONTRACT.md` → README `:27,29,30,288,289,290`，
  CONTRACT `:532,663..667`（均为边界声明，不是描述性括注）。
- `rg -n 'generation' docs/CONTRACT.md README.md` → README `:54`；CONTRACT `:207`（G2 新段）。
- activity 段人工复核：不再同时出现「不构成能力承诺」与「冻结契约条目」；per-task 两条已降级为
  「shim 形状（上游落地后才生效的形状约束，不是能力承诺）」，REV-8 保留。
- `CONTRIBUTING.md:9` 有 `## Tool surface changes`；CONTRACT 无「工具集（6 个）」。
- `docs/CONTRACT.md:498-501` 覆盖 cwd/env/watch 三句。

## 4. 变更文件

```
 CONTRIBUTING.md                | 19 ++++++++++++++
 README.md                      | 17 +++++++++++-
 docs/CONTRACT.md               | 80 ++++++++++++++++++++++++++++-----
 src/core/bus.ts                |  6 +++++
 docs/reports/contract-cleanup.md (本文件)
```

没有 `git add -A`；只显式 add 上述文件。未改：`package.json`（不加 `os`）、任何 `src/` 行为、
任何工具 schema、任何测试。

## 5. 未做 / 后续

- 不做 daemon/IPC，不改 `suspend()` 的 `waiters.clear()`（issue 明确禁止）。
- 不收敛 settle-guard 的私有 activity 实现（见 §2.1，需另开 issue）。
- 不放宽/扩围漂移门测试（见 §2.3，测试改动超出本次 doc-only 范围）。
- 不给 `R` 补「复刻 watch/timeout」（issue 明确不建议）。
- 不加 CHANGELOG 条目：本 PR 是纯文档/注释，且 `[Unreleased]` 段目前题为「只改任务详情视图」（#101）；
  强行插入 Docs 段会改写该发布叙事，收益低于风险。
- `docs/CONTRACT.md:557` 的 activity spinner 推理与 `CHANGELOG.md:673-674` 的历史措辞保留原样，
  已在 §2 记录。

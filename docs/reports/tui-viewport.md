# #101 — TUI 详情视口：把「选择」与「滚动」拆开

- issue：`zzjcool/pi-async#101`（P2；父 #81 的 4.1 + 4.2 中的 4.1 部分）
- 基线：`main` `985a083`（v0.5.0 线）；分支 `pi-subagent/pi-async-101-e101d210`
- 范围：D1（选择/滚动分离）、D2(a)（统一视口，折叠区可达）、D3（退化视口保留 header）
- **需要 REV**：`docs/CONTRACT.md` §8 / §21.1 的冻结条文已与实现不符，本轮按实现约束**未改契约**，
  逐条列出并给出建议措辞（§3）
- 未含：D4（Kitty 键盘编码）——见 §6.1

## 1. 改前 / 改后

同一任务（`viewport-two`，200 行输出 + 14 行 command + 4 个 metadata 键），120×36 终端，真实 pi TUI
（截图来自 §5 的 pty 取证，左侧聊天列已裁掉）。

### 改前（`985a083`，详情打开＝输出尾部）

```
╭─ Async task detail ─╮
│ viewport-two [bcaf5a44-…]              │
│ status: completed · elapsed: 0s        │
│ … (+13 lines)                          │  ← 折叠的是 command/metadata 的**前部**
│   echo '--- second log done ---'       │
│ ───────────────────────────────────    │
│ metadata:                              │
│   outputFile: …/…-…-…-….output         │
│   capped: false                        │
│   notifyOnCompletion: true             │
│   remindIntervalMs: 1200000            │
│   triggerOnCompletion: true            │
│ ───────────────────────────────────    │
│ output:                                │
│ second log line 194 …                  │
│ …                                      │
│ second log line 200 of a …             │
│ --- second log done ---                │
│ Esc return · x kill/cancel · R rerun · c show output path · ↑/↓ scroll │
╰────────────────────────╯
```

同一个终端里只有 8 行输出（`MIN_OUTPUT_ROWS` 下限 + chrome 扣减），`echo` 那 14 行 command **任何按键都
到不了**；按 `↑` 会切到上一个任务（标题变成 `viewport-demo`，见 §5 的基线截图），而 `PgUp` 滚 19 次后
`command:` 仍然不出现（截图同 §5）。

### 改后（本分支）

尾部（`scroll = 0`，header/footer 固定，窗口 26 行全是输出）：

```
╭─ Async task detail ─╮
│ viewport-two [e06c5b5f-…]              │
│ status: completed · elapsed: 0s        │
│ second log line 182 …                  │
│ …                                      │
│ second log line 200 of a …             │
│ --- second log done ---                │
│ Esc return · [ ] task · x kill · R rerun · c show output path · ↑/↓ scroll │
╰────────────────────────╯
```

上滚 3 页：`… (+154 lines)` 是**滚动位置标记**（替换窗口首行，不额外占行），header/footer 不动：

```
│ status: completed · elapsed: 0s        │
│ … (+154 lines)                         │
│ second log line 122 …                  │
```

16 次 `PgUp` 到文档顶部：**原先被折叠的 command/metadata 全部可读**，标记消失（上方 0 行）：

```
│ status: completed · elapsed: 0s        │
│ ──────────────────────────────────     │
│ command:                               │
│   set -e                               │
│   say() {                              │
│     echo "second task step $1"         │
│   }                                    │
│   for step in red green blue …; do     │
│   …                                    │
│ ──────────────────────────────────     │
│ metadata:                              │
│   outputFile: /tmp/…/….output          │
│   capped: false                        │
│   notifyOnCompletion: true             │
│ Esc return · [ ] task · x kill · …     │
```

## 2. 语义决定

| 项 | 决定 |
|---|---|
| 详情 body | 一个可滚动文档：`divider / command / divider / metadata / divider / output 标签+行`。`scroll` = 窗口下方隐藏的行数（0 = 贴尾），因此 D-32 的「新输出不推走正在读的行」度量的还是同一件事。 |
| 固定行 | 顶部 title+status；底部 `actionError` / kill 确认行 / 键位提示。kill 确认与错误行**钉住**而不是随文档滚：看不见的「再按一次确认」是陷阱（review 发现）。 |
| 窗口高度 | `budget = height - 2`；`windowRows = budget - bottom.length - fixed`，`fixed = min(2, budget - bottom.length)`。24 行终端窗口 14 行、40 行 27 行（旧实现是 8 行）。不再有 `MIN_OUTPUT_ROWS = 8` 下限，也不再逐项扣 chrome。 |
| `… (+K lines)` | 只在离开尾部（且窗口上方还有行）时出现，替换窗口首行，`K = 标记上方未显示的行数`；贴尾与文档顶部都不出现。 |
| D1 键位 | 详情内 `↑`/`↓`/`j`/`k` 只滚一行、不改选中；`PgUp`/`PgDn` 一页 = 当前窗口行数；新增 `[` / `]` 切上一个/下一个任务并回到该任务尾部（到两端时不动，也不会把上滚的视图拉回尾部）。列表模式完全不变（`↑`/`↓`/`j`/`k` 只选择）。 |
| D3 退化视口 | 优先级 footer > title > status > 窗口：`budget = 2` 时只剩 title + footer，`budget = 3` 时 title + status + footer，`budget ≥ 4` 才有窗口。 |
| 任务切换 | `[`/`]` 只清 `actionError`（不把上一个任务的 kill 失败带进新任务）并重置视图到新任务的尾部。 |

## 3. 需要 REV（`docs/CONTRACT.md` 冻结条文，按约束未改）

> 规则的来源：`docs/CONTRACT.md:4`「任何字段/语义变更必须走 REV 条目登记原因」。本轮交付只含代码 + 测试 +
> README/CHANGELOG；契约条文留给 REV-31。下面每条都给出可直接复制的建议措辞。

| # | 条文 | 现状 | 建议 REV-31 措辞 |
|---|---|---|---|
| R1 | `§21.1`「输出窗口按剩余高度分配（带下限）：`outputRows = max(MIN_OUTPUT_ROWS = 8, budget - chrome)` …加下限后超发行由 `withBodyBudget` 折叠」+ 24/40 行实测表 +「`withBodyBudget` 的 `… (+K lines)` 语义不变」 | `MIN_OUTPUT_ROWS` / `withBodyBudget` / `DETAIL_HEADER_LINES` 已删除；窗口 = body 视口，24 行 14 行、40 行 27 行，无折叠 | 「详情 = 固定 header（title/status）+ 可滚 body 窗口 + 固定底部（`actionError`/kill 确认/footer）；窗口行数 = `budget - bottom - min(2, budget - bottom)`，无 8 行下限、无逐项 chrome 扣减。24 行终端窗口 14 行、40 行 27 行。」 |
| R2 | `§8`「详情帧保留 header + footer 键位提示（超预算时保留最后 N 行并插 `… (+K lines)`）」；`§16 REV-18 影响面` 同句 | 没有「保留最后 N 行」这一步：贴尾无标记；上滚时标记替换窗口首行；文档顶部也无标记 | 「详情帧保留 header + footer 键位提示；body 超出窗口时不折叠，改为可滚动视口。`… (+K lines)` 是滚动位置标记：仅当离开尾部且窗口上方还有行时出现，替换窗口首行（不占额外行），K = 标记上方未显示的行数；贴尾与文档顶部不显示。」 |
| R3 | `§21.1`「PageUp/PageDown 步长 = 当前**输出**窗口行数」 | 步长 = 视口窗口行数（含 divider/command/metadata），24 行时 14、40 行时 27 | 「PageUp/PageDown 步长 = 当前视口窗口行数（模块级 `pageStep`，每次详情渲染更新）。」 |
| R4 | `§8` 键位表「键位 `x`（或 `K`）kill / `R` rerun / `c` 显示 output 路径 / `q` 关闭；列表内 `k` 是上移」 | 详情内 `↑`/`↓`/`j`/`k` 只滚 body；`[`/`]` 是新键；kill/rerun/copy 只在详情内生效 | 「详情内 `↑`/`↓`/`j`/`k` 只滚 body、不改选中任务；`PgUp`/`PgDn` 一页 = 当前窗口行数；`[` / `]` 切上一个/下一个任务并回到该任务尾部（到两端时不动）。列表内 `↑`/`↓`/`j`/`k` 仍是选择，`k` 仍不是 kill（REV-18 不变）。`x`/`R`/`c` 仅详情内生效。」 |
| R5 | `§21.1`「上滚锚定 …（`lastOutputCount <= lastOutputRows`）时直接 `scroll = 0; follow = true`」 | 判据改为按整份 body：`lastContentRows <= lastWindowRows` | 「（`lastContentRows <= lastWindowRows`，按整份 body 行数计）」 |
| R6 | `§21.1`「output 标签（`outputSection` 第 5 个可选参数 `live`）」 | 面板改用私有 `outputLabel`/`outputRow`；`outputSection` 保留为 4/5 参 helper | 「标签由 `outputLabel(truncated, theme, live)` 生成；`outputSection` 保留为 4/5 参 helper。」 |
| R7 | `§8` 面板段「详情帧保留 header …（超预算时…）」的 header 覆盖度 | D3 的优先级 footer > title > status > 窗口：`budget = 2` 时只留 title | 在 R2 后补一句：「退化视口优先级 footer > title > status > body；`budget ≥ 3` 时 title+status 都在。」 |

CHANGELOG / README 已与实现对齐（不在冻结面）；`docs/` 只新增本报告。

## 4. 测试

### 4.1 单元测试（`tests/`）

| 文件 | 变更 |
|---|---|
| `tests/d-tui-keys.test.ts` | 改写「detail k 滚而不切任务」；新增「列表箭头选择 / 详情箭头只滚（↑ 与 ↓ 两侧）」「`[`/`]` 切换并在两端不动、不拉回尾部」「kill 确认在上滚时仍可见」「上一个任务的 kill 错误不跟到下一个任务」「详情 footer 提示含 `[ ] task`」；文件级 `test.before` 固定 24 行终端，避免高 TTY 让整份 body 装下而静默关掉滚动 |
| `tests/c-panel-live.test.ts` | 新增 D2「长 command 下 `PgUp` 能读到原先被折叠的 command/metadata，header 固定」、D3「退化高度保留 header，且按滚动键不把 footer 挤出帧（行 6/7/9）」；改写 D-30 步长用例为**精确**窗口（一页后 `row 048` 在、`row 047` 不在、`… (+54 lines)`）；R2-3 改为「贴尾无标记 / 上滚后标记为 `… (+46 lines)` 且位于窗口首行」 |
| `tests/d-tui-refresh.test.ts` | 12 行终端：断言 title/status 固定在窗口上方、贴尾时窗口里能看到 metadata 的 `outputFile:`（旧实现的折叠在这一尺寸看不到），上滚后出现标记且 header 不动 |

`npm test`（`node --experimental-strip-types --test tests/*.test.ts`）：

| | tests | pass | fail | skipped |
|---|---:|---:|---:|---:|
| 基线 `985a083` | 436 | 407 | 16 | 13 |
| 本分支 | 443 | 414 | 16 | 13 |

`npm run typecheck` 绿。**16 个失败与基线逐条相同**（名单一致），全部是 macOS 环境导致的既有失败，与本
改动无关，例如：

```
not ok - pending delayed task can be canceled as a user kill
  error: 'Refusing to read task output outside the async data directory:
          /var/folders/…/pi-async-delayed-…/….output'
```

（`/var` → `/private/var` 的真实路径与 dataDir 前缀比较不一致；同批失败集中在 kill/cwd/hold/rail。）

### 4.2 仓库自带 TUI 场景

新增 `test/scenarios/s107-detail-viewport.json` + `s107-keys.txt`（+ `INDEX.md` 行、容器 README 的计数
72→73）：两个任务、长 command、200 行输出，按键为
`/async → j → Enter → ↑ → PgUp×3 → PgUp×12 → ] → [ → Esc`，快照
`list-two-tasks, detail-tail, detail-one-line-up, detail-scrolled, detail-top, detail-switched,
detail-switched-back, back-to-list`。本机**没有 docker daemon**，所以 `make qa-tui SCENARIO=s107` 无法在
这里执行；同一条按键序列用下面的 pty 方式在真实 TUI 上跑过（`!]` / `![` 是 tmux 的裸键写法）。

## 5. 真 TUI 验证（命令 + 观察）

本机 `docker` daemon 不可用、也没有 `tmux`，所以用「repo 自带 mock endpoint + 临时 pi HOME + pty +
最小 VT 屏」驱动**真实 pi 1.6.0 TUI**（不是进程内假宿主）：

```sh
# mock endpoint: test/docker/tools/mock-llm.py，脚本 = 两个 async_run（长 command，各 200 行输出）
# 临时 HOME：symlink ~/.pi/agent/npm（离线解析 provider）+ auth/models-store 指向 mock
# pty 120×36，pi --model any-endpoint/mock-model -e <worktree>/extensions/index.ts
cd /tmp/tui-viewport-run && python3 -u driver.py
# 同一脚本跑基线（git archive 985a083 到 /tmp/pi-async-baseline）：
PI_ROOT=/tmp/pi-async-baseline PI_ART=/tmp/tui-viewport-run/artifacts-baseline python3 -u driver.py
```

检查只读**面板区域**（面板居中，背后聊天文本不参与判定）：

| 检查 | 基线 `985a083` | 本分支 |
|---|---|---|
| 详情帧出现 / 贴尾显示最新输出 / 贴尾不显示 command 块 | PASS | PASS |
| title / status 固定 | PASS | PASS |
| footer 提示（`x kill`、`↑/↓ scroll`、`[ ] task`） | **FAIL**（无 `[ ] task`） | PASS |
| 详情按 `↑` 不切任务 | **FAIL**（标题 `viewport-two` → `viewport-demo`） | PASS |
| 离开尾部后出现 `… (+K lines)` 且位于固定 header 之下 | PASS | PASS |
| `PgUp` 能到 `command:` / 命令正文 / `metadata:` | **FAIL**（19 次 `PgUp` 后仍无 `command:`） | PASS |
| 文档顶部不再显示标记 | **FAIL**（旧实现永远显示） | PASS |
| `[` 在详情内切任务 | **FAIL**（键未绑定，什么也没发生） | PASS |
| `q` 关闭面板 | PASS | PASS |

基线 5 项 FAIL / 本分支 15 项全 PASS。基线证据（同一次运行，120×36）：

```
# 基线：详情里按一次 ↑ —— 标题换成了上一个任务（D1 的真 bug）
│ viewport-demo [dfa2f4e3-…]
│ status: completed · elapsed: 0s
│ … (+13 lines)
# 基线：19 次 PgUp 之后 —— 标记还在，command/metadata 起始行依然不可达
│ … (+13 lines)
│   echo '--- log done ---'
│ ────────────────────────────────
│ metadata: … / output: … (只有输出尾部)
```

产物：`/tmp/tui-viewport-run/artifacts/`（本分支）、`/tmp/tui-viewport-run/artifacts-baseline/`（基线）。
取证脚本是本机临时工具（`/tmp/tui-viewport-run/driver.py`），不入库——仓库里的等价可复现形式是 §4.2 的
`s107` 场景。

## 6. 已知取舍 / 未做

1. **D4（Kitty 键盘编码）不在本轮**：父任务把范围限定为「选择 vs 滚动的视口模型」，`panel.ts` 里的
   `"\r"` / `"\u001b[A"` / `"\u001b[B"` 裸字节比较与丢弃的 `keybindings` 保持原样，`\x1b[13;2u` /
   `\x1b[1;2A` 仍未覆盖。因此**modified arrow（如 Shift+↑）不会滚动**——普通方向键不受影响。需要另一轮
   落实（issue #101 的 D4）。
2. `output (live):` 标签随 output 块一起滚：长日志贴尾时它不在屏上；`status: running` 仍固定在顶部，是
   实时的权威指示。这是统一视口的直接后果（不再为标签保留固定行）。
3. 第一次 `↑` 由标记占用窗口首行：视觉上「顶部内容不动、底部掉一行」，第二次起每按一次多露一行；标记
   本身给出「上方还有 K 行」。
4. 128 KiB UI tail 之上的锚定（D-32）仍是既有边界：日志超过 128 KiB 后 tail 变成滑动窗口，
   `outputLines.length` 不再增长，锚点失效——**基线同样如此**，本轮未改，仅在报告记录。
5. 滚轮方向在两个模式相反（列表 `+1` 向下、详情 `+1` 向旧行）是既有行为，未动。

## 7. 改动文件

```
src/tui/panel.ts                 # 视口 + 选择/滚动分离（+ 私有 outputLabel/outputRow）
src/guard/hold.ts                # 指向 panel.ts 的行号引用 424 → 421（本次改动导致漂移）
tests/d-tui-keys.test.ts         # D1 键位、[ ]、确认行、错误行清理
tests/c-panel-live.test.ts       # D2/D3、D-30 步长精确化、R2-3 新语义
tests/d-tui-refresh.test.ts      # 短终端 header/footer/marker
README.md                        # 键位表（↑/↓、PgUp/PgDn、[ ]、Enter、x/R/c 的详情限定）
CHANGELOG.md                     # 0.5.0「Changed（TUI 详情视口，#101）」
test/scenarios/s107-detail-viewport.json
test/scenarios/s107-keys.txt
test/scenarios/INDEX.md          # s107 行 + 计数
test/docker/README.md            # 场景计数 72 → 73
docs/reports/tui-viewport.md     # 本报告
```

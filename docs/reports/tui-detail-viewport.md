# 0.5.1 — TUI 详情视口：把「选择」与「滚动」拆开（#101）

- 分支：`pi-subagent/host-workspace/piasync-101-074e4c57`（独立 worktree `/root/code/.pi-worktrees/piasync-101`）
- 基线：`origin/main` `985a083`（0.5.0 已发）
- 版本：`CHANGELOG.md` 顶部新增 `## [Unreleased] — 0.5.1 (patch)`；**未发版、未打 tag、未 `npm publish`**，
  `package.json` 仍是 `0.5.0`（版本号由 release 提交单独抬，沿用 0.4.x 的做法）。
- 契约：`docs/CONTRACT.md` §8（键位表）、§21.1（视口语义）、新增 §24（REV-31）。
- 改动面：行为只在 `src/tui/panel.ts`；另有测试、README、CONTRACT、CHANGELOG 与本报告。

本文件只记录可复核的事实：三个缺陷的改前/改后、最终键位与契约措辞、每条验收的「撤掉修复即红」证据、
独立审查的结论、以及测试条数。

## 1. 结论

| 缺陷 | 状态 | 新断言 | 撤掉修复 |
|---|---|---|---|
| **D1** 详情里 `↑`/`↓`/`j`/`k` 同时切换选中任务 | 已修：详情内只滚视口，换任务改用 `[`/`]` | `tests/d-tui-keys.test.ts` | **红** |
| **D2** `… (+K lines)` 折叠区不可达 | 已修：详情体统一成一个视口，上滚读回 | `tests/c-panel-live.test.ts` | **红** |
| **D3** 退化视口只剩 footer，header 消失 | 已修：footer 先留、再补 title，内容有一行给一行 | `tests/c-panel-live.test.ts`、`tests/d-tui-keys.test.ts` | **红** |

- 全量 `npm test`：**435 → 441**（新增 6 例；0 条删除、0 条放宽、0 条 `|| true`），`npm run typecheck` 绿。
- 既有断言只有一处随契约翻转（`detail k …`），见 §6；其余既有断言一条未改，另有两处**加强**
  （D-30 一页窗口的边界、`… (+K lines)` 的 K 值）。
- 独立审查（fresh-context，§5）抓出 2 个 major：退化视口在多行 footer 下会把键位提示切掉、详情滚轮方向
  与 `↑`/`↓` 相反。两个都已修并补了回归断言（多出来的 2 条测试即来自这里）。

## 2. 三个缺陷：改前 / 改后

几何说明：从 rail 直入详情时面板取 `80%` 高，从列表 `Enter` 进详情时面板取 `70%` 高（0.5.0 起如此，
本次不动）。下面的屏幕都是 `component.render(80)` 的输出（ANSI 已剥离，节选处用 `…` 表示连续行）。

### 2.1 D1 — 详情里的移动键会换任务

**改前**（`move()` 先改 `selected` 再改 `scroll`，详情渲染读的是 `selected`）：

```ts
const move = (delta: number): void => {
  ...
  if (next) selected = next.taskId;
  if (detail && delta < 0) { scroll += -delta; follow = false; }
  else if (detail && delta > 0) { scroll = Math.max(0, scroll - delta); follow = scroll === 0; }
```

**改后**（详情走 `scrollBy`，选择只由列表键与 `[`/`]` 驱动）：

```ts
if (data === "\u001b[A" || key === "k") { if (detail) scrollBy(1); else move(-1); return; }
if (data === "\u001b[B" || key === "j") { if (detail) scrollBy(-1); else move(1); return; }
if (detail && data === "[") { move(-1); return; }
if (detail && data === "]") { move(1); return; }
```

改前：24 行终端（列表进详情，16 行帧）、40 行日志。`k` 把「读日志」变成「上一个任务」：

```
--- D1 tail (alpha selected) ---
╭─ Async task detail                                                          ─╮
│ alpha [a]                                                                    │
│ status: running · elapsed: …                                                 │
│ … (+6 lines)                                                                 │
│ ────────────────────────────────────────────────────────────────             │
│ output (live):                                                               │
│ row 33 … row 40                                                              │
│ Esc return · x kill/cancel · R rerun · c show output path · ↑/↓ scroll       │
```

改后：同一场景，`k` 只上滚一行，`[alpha]` 不动；`[`/`]` 才是换任务：

```
--- D1 after k ---
╭─ Async task detail                                                          ─╮
│ alpha [a]                                                                    │
│ status: running · elapsed: …                                                 │
│ … (+37 lines)                                                                │
│ row 30 … row 39                                                              │
│ Esc return · ↑/↓ scroll · [ ] task · x kill · R rerun · c show output path   │
```

### 2.2 D2 — `… (+K lines)` 折叠区没有任何按键可达

**改前**：`scroll` 只切输出尾窗（`outputLines.slice(...)`），`withBodyBudget` 把 command/metadata
**永久**折进标记；`scroll` 的夹取范围是 `outputLines.length - outputRows`，输出比窗口短时恒为 0 ——
PageUp/↑ 完全无效：

```
--- D2 tail (folded) ---        --- D2 after 6x PageUp ---   ← 改前：一模一样
│ … (+37 lines)                 │ … (+37 lines)
│ row 001 … row 005             │ row 001 … row 005
```

**改后**：详情体 = 固定 header（title+status）+ 可滚动内容（分隔线 + command + metadata + output
标签 + 全部输出行）+ 固定 footer；`scroll` 夹取到 `contentCount - viewportRows`，PageUp 一页 = 一个视口：

```
--- D2 after 6x PageUp ---
╭─ Async task detail                                                          ─╮
│ deploy [fold-1]                                                              │
│ status: running · elapsed: …                                                 │
│ ────────────────────────────────────────────────────────────────             │
│ command:                                                                     │
│   echo step 01 … echo step 04                                                │
│ Esc close · ↑/↓ scroll · [ ] task · x kill · R rerun · c show output path    │
```

（`command:` 与前 4 行是 `rows=14` 终端下 `30` 行 command 的前 4 行 —— 正是改前读不到的那一段。）

### 2.3 D3 — 退化视口只剩 footer

**改前**：`if (tailCount <= 0) return [last];` —— 7 行终端整帧只剩键位提示，title/status 消失；
8 行终端只剩 header + 标记 + footer，最新输出也丢了：

```
7 行：╭──╮ │ Esc close · x kill/cancel · … │ ╰──╯          ← 没有 title/status
8 行：│ watch [tiny-2] │ status: … │ … (+9 lines) │ Esc close … │   ← 内容全空
```

**改后**：先扣 footer（告警 + 键位提示）与 header 再算视口，`budget <= header + footer` 时按
「footer 优先、再补 title」填满而**不溢出**；只要还剩一行内容就留给视口：

```
7 行：│ watch [tiny-1] │ status: running · elapsed: … │ Esc close · ↑/↓ scroll · [ ] task · … │
8 行：│ watch [tiny-2] │ status: running · elapsed: … │ out line │ Esc close · … │
```

footer 涨到 3 行（`error` + kill 二次确认 + 键位提示）时同样先留 footer：

```
8 行 + error + 确认：│ watch [tiny-1] │ error: … │ Kill this task? press x again to confirm… │ Esc close · … │
```

### 2.4 顺带收敛：告警不再跟着内容滚

`actionError` 与 kill 二次确认提示原来在可折叠区里（矮终端会被折掉）。现在它们并入 footer 区
（`[...alerts, footerLine()]`），不随视口滚动；只有在终端矮到**连 footer 本身都放不下**时才会先丢
error 行（键位提示那一行永远保留）。

### 2.5 顺带修正：详情滚轮方向（D5）

宿主把「滚轮向下」编码为**正**的 `wheelDelta`（`@earendil-works/pi-tui` 的 alt-screen 解析：
`direction = button & 3 === 0 ? -1 : 1`，`wheelDelta = direction * lines`）。0.5.0 的
`scroll = Math.max(0, scroll + delta)` 里 `scroll` 是「距尾部行数」，于是**向下滚反而上滚**，
与 `↓`/`PageDown` 相反（列表视图用 `move(delta)`，方向一直是对的）。改成 `scroll - delta`。
回归断言：`tests/c-panel-live.test.ts` 的「the detail wheel scrolls the same way as ↓/PageDown」。

## 3. 最终键位（README / CONTRACT §8 同步）

| 键 | 列表 | 详情 |
|---|---|---|
| `↑` / `↓` / `j` / `k` | 选择任务（不变） | **只滚视口**（一行），不换任务（REV-31） |
| `PageUp` / `PageDown` | 无效（不变） | 滚一个视口（一页 = 一个窗口，窗口定义从「输出窗口」改成「视口」） |
| `[` / `]` | 无效 | **上一个 / 下一个任务**（新增，替代详情内用方向键换任务的旧行为） |
| 滚轮 | 滚列表（不变） | 滚视口，方向与 `↓`/`PageDown` 一致（D5 修正） |
| `Enter` | 进详情 | — |
| `x`（或 `X`/`K`） | — | kill（二次确认；pending 任务为 cancel） |
| `R` / `c` / `q` / `Esc` | 不变 | 不变 |

详情 footer 提示行（80 列下完整可见）：

```
Esc close · ↑/↓ scroll · [ ] task · x kill · R rerun · c show output path
```

契约措辞（`docs/CONTRACT.md`）：

- §8 面板条：`**详情内 ↑/↓/j/k 只滚视口、不改选中任务，换任务用 [`（上一个）/`]`（下一个）**（REV-31）`；
  `高度不足时 command/metadata 落在窗口外（顶部「… (+K lines)」的 K = 窗口上方隐藏行数，上滚可读回），
  退化到连一行内容都放不下时先留 footer（告警 + 键位提示）再补 title`。
- §21.1：`详情体是一个视口（#101 / REV-31 起）` —— `viewportRows = budget - header - footer`、
  `scroll` = 距尾部行数、`pageStep = viewportRows`；折叠判据改为
  `middle + MIN_OUTPUT_ROWS > viewportRows`；实测表（80 列 / running / 200 行输出）：

  | 终端行数 | metadata 键数 | 渲染出的输出行 | 折叠标记 |
  |---|---|---:|---|
  | 40 | 3 | 27 | 否 |
  | 24 | 3 | 13 | 是 |
  | 40 / 24 | 0 | 27 / 13 | 否 / 是 |

- 新增 §24（REV-31）：三个缺陷的裁决（D1/D2/D3 + D5 顺带修正）、语义与不变量、用户可见差异、
  回退方式、验收清单。**回退开关：无** —— 回退即把详情分支整段退回 0.5.0 的 `withBodyBudget` 实现。

## 4. 变异证据（逐个撤掉修复 → 对应断言必须红）

每个变异都用 `node --test --test-name-pattern=…` 只跑目标用例，跑完立即还原（`cp` 回备份）。

### 4.1 撤掉 D1（让详情移动键重新走 `move()`）

```diff
-        if (data === "\u001b[A" || key === "k") { if (detail) scrollBy(1); else move(-1); return; }
+        if (data === "\u001b[A" || key === "k") { move(-1); return; }
   ...
+        if (detail && delta < 0) { scroll += -delta; follow = false; }
+        else if (detail && delta > 0) { scroll = Math.max(0, scroll - delta); follow = scroll === 0; }
```

```
✖ #101 D1: ↑/↓/j/k scroll the detail body and never move the selection
  AssertionError [ERR_ASSERTION]: ↓ in detail must not switch tasks either
    actual: │ beta [b] │ … │
    expected: /\[a\]/
ℹ tests 1 / pass 0 / fail 1
```

### 4.2 撤掉 D2（把滚动范围退回输出窗口）

```diff
-      scroll = Math.min(scroll, Math.max(0, contentCount - viewportRows));
+      scroll = Math.min(scroll, Math.max(0, outputLines.length - viewportRows));
```

```
✖ #101 D2: a command folded behind `… (+K lines)` is reachable by scrolling up
  AssertionError [ERR_ASSERTION]: PageUp reaches the command label
    actual: │ … (+37 lines) │ row 001 … row 005 │ (6 次 PageUp 之后仍在尾部)
    expected: /command:/
ℹ tests 1 / pass 0 / fail 1
```

### 4.3 撤掉 D3（退化视口退回「只返回 footer」）

```diff
-      if (budget <= header.length + footer.length) {
-        const keptFooter = footer.slice(Math.max(0, footer.length - budget));
-        return [...header.slice(0, Math.max(0, budget - keptFooter.length)), ...keptFooter];
-      }
+      if (budget <= header.length + 1) return [...header.slice(0, Math.max(0, budget - 1)), footer[footer.length - 1]!];
```

```
✖ #101 D3: a degenerate viewport keeps the identity lines, not just the footer
  AssertionError [ERR_ASSERTION]: rows=7: the title line survives the degenerate viewport
    actual: │ Esc close · ↑/↓ scroll · [ ] task · x kill · R rerun · c show output path │
    expected: /tiny-1/
✖ #101 D3: a degenerate viewport keeps the alerts and the key hints
  AssertionError [ERR_ASSERTION]: the key hints are still directly above the bottom border
    actual: │ Kill this task? press x again to confirm; any other key cancels │
    expected: /x kill/
ℹ 8 行用例仍绿：它验的是「视口留一行内容」，不是这条分支
```

### 4.4 撤掉 D5（滚轮加回 `+ delta`）

```diff
-          if (detail) { scroll = Math.max(0, scroll - delta); follow = scroll === 0; }
+          if (detail) { scroll = Math.max(0, scroll + delta); follow = scroll === 0; }
```

```
✖ #101: the detail wheel scrolls the same way as ↓/PageDown
  AssertionError [ERR_ASSERTION]: wheel up moves one line off the tail (window is now 073..099)
    (改回去后滚轮向上 = 停在尾部，窗口仍是 074..100)
```

### 4.5 旁证：把 `src/tui/panel.ts` 整体退回基线 `985a083`

新用例在 0.5.0 的代码上全红，且红的原因正是三个缺陷（不是用例写错）：

```
✖ #101 D1: ↑/↓/j/k scroll the detail body and never move the selection
    AssertionError: ↓ in detail must not switch tasks either      → actual 显示 │ beta [b] │
✖ #101 D2: a command folded behind `… (+K lines)` is reachable by scrolling up
    AssertionError: PageUp reaches the command label              → actual 显示 … (+37 lines)
✖ #101 D3: a degenerate viewport keeps the identity lines, not just the footer
    AssertionError: rows=7: the title line survives …             → actual 只有 footer 一行
✖ #101 D3: the one content row a tiny terminal has still shows the newest output
    AssertionError: the one content row still shows the newest output → actual 显示 … (+9 lines)
✖ detail k scrolls the body without killing or switching tasks (#101)
    AssertionError: k in detail must not switch tasks             → actual 显示 [a]
ℹ tests 5 / pass 0 / fail 5
```

## 5. 独立审查（fresh-context，只读）

派了一个全新会话的只读审查者（禁止改文件），审查面 = 视口几何/回归、键位、测试强度、文档一致性、死代码。
它跑了 `npm run typecheck`（干净）与 `npm test`（439/439，当时未加回归断言），报了 **2 个 major + 9 个 minor**：

| 级别 | 发现 | 处理 |
|---|---|---|
| major | 退化判据只算 `header.length + 1`，但 footer 最多 3 行（error + kill 确认 + 提示）：8 行终端同时有这两条时 `viewportRows = -1`、`pageStep` 反向、`slice(0, budget)` 把键位提示切掉 | **已修**：判据改 `budget <= header.length + footer.length`，先留 footer 再补 title；新增回归用例（8 行 + error + 确认） |
| major | 详情滚轮方向与 `↑`/`↓` 相反（宿主「向下」= 正 `wheelDelta`，`scroll` 是距尾部行数） | **已修**（D5）；新增回归用例 |
| minor | `… (+K lines)` 的 K 没有任何用例钉住 | 已在 D2 用例里逐字断言 `… (+37 lines)` |
| minor | D-30 的 PageUp 用例注释写「20 行窗口」，实际是 27 行视口；断言只查 `row 061` 存在，20/27 都能过 | 已改注释并**加强**断言：`row 047` 在窗口顶、`row 074` 已出窗 |
| minor | `MIN_OUTPUT_ROWS` 注释还叫它「输出行下限」 | 已改：它现在只决定「要不要画标记」 |
| minor | §8 仍写「折进 `… (+K lines)`」（旧 K 语义） | 已改为「K = 窗口上方隐藏行数」 |
| minor | CHANGELOG 说「缩成 `x kill` 好让 `c show output path` 不被截断」算术不成立（新 footer 73/74 格 > 旧 69 格） | 已改成「为压进 80 列内宽 76 格」 |
| minor | R2-3 用例注释仍在描述已删掉的 `withBodyBudget` | 已改 |
| minor | 视口 0/1 行时隐藏行无标记 | 接受：1 行视口放不下标记，且这正是 D3 的「先留内容」；契约里写的是标记为「计数」而非保证 |
| minor | 128 KiB 尾部饱和后 D-32 锚定会漂 | 接受：0.5.0 同病，未新增回归，留给后续 issue |
| minor | `outputSection([], …)[0]!` 只为取 label | 接受：复用 label 逻辑（含 `live`/`truncated` 标记），比复制一份更安全 |
| minor | d-tui-keys 新增第 4 份 `withTerminalSize` | 接受：三个既有测试文件本来就各自持有一份，测试文件保持自洽 |

审查者明确未发现 critical，并确认既有断言未被放宽（`git diff 985a083 -- tests/` 只有 1 行翻转 + 纯新增）。

## 6. 既有断言：一处随契约翻转（不是放宽）

`tests/d-tui-keys.test.ts` 原用例 `detail k scrolls up instead of killing` 断言的正是 D1 这个缺陷：

```ts
- assert.equal(panel.killed.length, 0);
- assert.match(…, /\[a\]/, "k in detail moves to the previous task");   // ← 断言缺陷本身
```

issue #101 的验收标准明写「详情模式按 ↑ 后 selected 不变」，所以这条断言必须翻转。改动方式是
**换向加强**，不是删除也不是放宽：

- 保留：`k` 永不 kill（`assert.equal(panel.killed.length, 0)`）。
- 翻转：`k` 后仍必须是 `[b]`，并新增 `[`/`]` 的换任务断言。
- 其余所有既有断言（D-30 / R2-1 / R2-3 / D-31 / D-32 / D-33 / R2-2 / R2-4、`d-tui-refresh` 的
  「短终端折叠 + footer 可见」、`c-panel-overlay` 的高度/宽度、`c-panel-detail-theme` 的对齐）
  一条未改；另有两处加强（D-30 边界、marker K）。

## 7. 测试条数

| | 条数 | 说明 |
|---|---:|---|
| 0.5.0 基线（`985a083`） | 435 | — |
| 本次 | **441** | +6：`#101 D1`、`#101 D2`、`#101 D3`（2）、滚轮方向、退化视口 + 告警（2 条来自审查修复）；旧 `detail k …` 改写成新契约，条数不变 |

```
$ npm run typecheck
> tsc --noEmit                # 0 error
$ npm test
ℹ tests 441
ℹ pass 441
ℹ fail 0
```

## 8. 变更文件

| 文件 | 变更 |
|---|---|
| `src/tui/panel.ts` | 删 `withBodyBudget`/`DETAIL_HEADER_LINES`，详情体改成 header + 视口 + footer；`move()` 拆出 `scrollBy()`；新增 `[`/`]`；退化判据按 footer 行数；滚轮方向修正；footer 提示行加 `[ ] task` 并把 `kill/cancel` 缩成 `kill` |
| `tests/d-tui-keys.test.ts` | 改写 `detail k …` 为新契约；新增 `#101 D1` 与「退化视口 + 告警」（13→15 例） |
| `tests/c-panel-live.test.ts` | 新增 `#101 D2`、`#101 D3`（2 例）、滚轮方向；D-30 边界断言加强、两处过期注释（11→15 例） |
| `README.md` | 键位表：`↑/↓/j/k` 语义、新增 `PageUp`/`PageDown` 与 `[`/`]` 行、`Enter` 行改写 |
| `docs/CONTRACT.md` | §8 面板条、§21.1 视口语义、新增 §24（REV-31） |
| `CHANGELOG.md` | 新增 `## [Unreleased] — 0.5.1 (patch)`（Fixed ×4 / Changed ×4） |
| `docs/reports/tui-detail-viewport.md` | 本文件 |

## 9. 没做 / 已知限制

- **issue 的 D4（Kitty `matchesKey`/`keybindings`）不在本次范围**：派发只要求三个缺陷 + 文档同步；
  D4 是输入解码（`\r`/`^[[A`/`^[[B` 的裸字符串比较与 Shift+Enter `\x1b[13;2u`、
  modified arrow `\x1b[1;2A`），与视口无关，留给下一个 issue。Kitty「report all keys」下 `[`/`]`
  会到 `\u001b[91u`/`\u001b[93u` —— 与 D4 同一类问题，一并在下一个 issue 处理（本仓已有 `\u001b[27u`
  的 Esc 特判，说明宿主确实传原始串）。
- `output (live):` 标签现在随内容滚动（长日志时在窗口上方），不再常驻；`… (+K lines)` 的 K 改成
  「窗口上方隐藏的总行数」。两条都写进了 CHANGELOG 与 CONTRACT §24.2。
- 视口是「距尾部行数」的模型，没有 `Home`/`End`/`g`/`G`（issue 的「不做」清单）；一页 = 一个视口。
- 128 KiB UI 尾部读满后输出行数饱和，D-32 的锚定补偿会停止（0.5.0 同病，未新增回归）。

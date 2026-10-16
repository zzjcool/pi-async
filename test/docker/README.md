# 容器化测试（test/docker）

把宿主的 pi-async 源码挂进干净容器，验证「模型能调通 + 工具真注册 + 工具真能跑」。
镜像里固化 pi 1.2.0 + `pi-any-endpoint` + TUI 取证工具链，`~/.pi/agent/bin` 不再需要联网下载 rg/fd。

## 一键用法

**日常体验（默认）：**

```sh
cd test/docker
make run        # 起容器 + 直接进入 pi，默认 model=workbuddy/hy4-preview-ioa
make it         # 同上（别名）
```

容器已在跑就复用（`--reuse`），不重建、不丢会话状态。换模型：`make run MODEL=workbuddy/gpt-6-luna`。

**其余目标：**

```sh
make help       # 全部目标
make build      # 构建镜像（>300s，tee 到 /tmp/pi-async-build.log）
make up         # 只起容器，不进 pi
make smoke      # 三层冒烟：模型可达 → 工具注册 → 工具真执行
make shell      # 只进容器 bash
make status     # 容器 + 镜像状态
make clean      # 删容器（镜像保留）

make qa-up      # 起 TUI 回归容器
make qa-tui SCENARIO=s1   # 跑单个确定性 TUI 场景
make qa-shell
```

路径全部从 Makefile 位置反推仓库根，不硬编码 `/root/...`。

## 两个容器

| 容器 | 用途 | 网络 |
| --- | --- | --- |
| `pi-async-test` | 真模型冒烟，挂宿主 `auth.json` + `models-store.json` | `--network=host`（**必须**：接入点是宿主进程） |
| `pi-async-qa` | 确定性 TUI 回归，容器内 mock LLM | bridge（不碰宿主模型） |

冒烟容器的三个挂载缺一不可：

```text
<repo>                        -> /mnt/pi-async              ro  源码，改宿主即生效
~/.pi/agent/auth.json         -> 同路径                      ro  模型接入点
~/.pi/agent/models-store.json -> 同路径                      rw  pi 要写回 checkedAt
```

源码是 `:ro` 挂载 —— **不要在容器里 `cd /mnt/pi-async` 再跑 pi**，插件按 `cwd` 落盘
（`cwd/.pi/async/...`）会写失败。镜像 WORKDIR 是 `/root`。

## 为什么 L3 不能省

L2 只证明工具出现在 prompt 里。模块解析失败、扩展注册抛错被吞、声明了但 handler 没挂，
L1/L2 全都照样绿。只有让模型**实际调用一次**工具（`async_run` + `async_logs`）才算验证。

## 确定性 TUI 回归

`tools/harness.sh` 起一个随机端口的脚本化 mock endpoint + 临时 pi HOME，用 tmux 驱动真实 TUI，
逐帧 `capture-pane` 再由 `tools/ansi2png.py` 渲染成 PNG。同一场景 + 同一按键序列 ⇒ 同一帧，
问题可原样复跑复现。harness 结尾断言 mock 至少收到过请求，否则 exit 1（模型没被调到的
「干净」产物毫无意义）。

**72 个可独立运行的场景**（json + keys 配对）在 `test/scenarios/`，见 `test/scenarios/INDEX.md`。
另有 30 个不配对的归档在 `test/scenarios/.attic/`（原因见该目录 README）。

产物落 `/qa/artifacts/<name>/`（不入库，见根目录 `.gitignore`）。

场景 id 对应的 json **文件名不统一**（`s1-single-task.json`、`s2-concurrent.json`、
`s105-rail-overflow.json`…），所以 `make qa-tui` 走 `tools/run-scenario.sh` 按 id 通配发现。
直接拼 `$(SCENARIO)-single-task.json` 会让除 s1 外全部失败 —— 这个 bug 已经修过一次。

## 镜像里烧了什么、为什么

- `pi 1.2.0` + `pi-any-endpoint@0.1.3`：provider 必须装，`pi install <本地路径>` 才能加载源码包。
- `ripgrep` + `fd-find`：pi 会话启动会 shell 出去找 rg/fd。两个都没有时它每次从 GitHub 下载
  静态二进制到 `~/.pi/agent/bin`（容器层，重建即丢 + 起手 10s 网络抖动）。`getToolPath()`
  退回 PATH 且认 `fdfind` 别名，Debian 包直接满足。验收：跑完会话 `ls ~/.pi/agent/bin`
  应**不存在**。
- tmux / python3-pil / fonts-noto-cjk：TUI 驱动、ANSI→PNG 渲染、CJK 不渲染成方框。
- 想彻底禁下载：启动加 `-e PI_OFFLINE=1`。

## 与 pi-legion 的关系

同样的模式（仓库内联 `test/docker/`），但 pi-async 的镜像只在本地构建，不发布 ghcr。
pi-legion 的 `tui-sandbox` 由 `.github/workflows/docker-tui-sandbox.yml` 在 master 上自动发布。

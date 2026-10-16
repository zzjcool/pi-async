# .attic —— 不可独立运行的场景

归档标准：json 与 keys 不配对，`harness.sh` 无法直接驱动。

- **28 个 KEYS-ONLY**：有 `sN-keys.txt` 但没有配套的 `sN-*.json`。
  没有 `--script` 时 `mock-llm.py` 回退成 `{"text":"mock response"}`，
  不会创建任何 async 任务 —— 产物看起来干净，实际什么都没测。
- **2 个 JSON-ONLY**（s51、s66）：有 json 没有 keys。

`run-scenario.sh` 会拒绝这些 id；确实要借用别的场景 json 时用
`REUSE_JSON=<id> run-scenario.sh <id>`。

**为什么留着不删**：PROGRESS.md 里 s13（issue #1 未能复现）、s100/s102（harness 时序伪影，
非产品缺陷）、s103（Esc 层级正确行为）等结论依赖这些按键序列，删掉就丢了当时的判据。
若后续补上配对的 json，可从这里取回。

编号缺失 s16 / s21 / s62 / s78：PROGRESS.md 无记载，未创建或已删，无从考证。

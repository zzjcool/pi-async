# pi-async 容器化测试 —— 一键入口
#
#   cd test/docker && make help
#
# 两个容器，各司其职：
#   pi-async-test  真模型冒烟（挂宿主 auth + models-store，--network=host）
#   pi-async-qa    确定性 TUI 回归（同一镜像 + 脚本化 mock LLM，无真模型）
#
# 路径全部从 Makefile 位置反推仓库根，不硬编码 /root/... ：
#   ROOT = <repo>/        SRC = <repo>  （插件源码）
#   TOOLS= <repo>/test/docker/tools   SCENARIOS= <repo>/test/scenarios
#
# 长命令（docker build / 全量 TUI）会超 300s 工具超时，故一律 tee 日志（后台跑）。

SHELL := /bin/bash
ROOT  := $(shell cd "$(dir $(lastword $(MAKEFILE_LIST)))/../.." && pwd)
TOOLS := $(ROOT)/test/docker/tools
SCEN  := $(ROOT)/test/scenarios

# 冒烟容器
NAME  ?= pi-async-test
IMAGE ?= pi-async-test:latest
MODEL ?= workbuddy/hy4-preview-ioa

# TUI 容器
QA_NAME   ?= pi-async-qa
SCENARIO  ?= s1
COLS      ?= 120
ROWS      ?= 36

.PHONY: help build up down run it smoke shell status logs clean qa-up qa-tui qa-shell

help: ## 显示帮助
	@grep -hE '^[a-z-]+:.*?## ' $(MAKEFILE_LIST) \
	  | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-10s\033[0m %s\n",$$1,$$2}'

build: ## 构建冒烟镜像（>300s，tee 到 /tmp/pi-async-build.log）
	@echo "构建中 → /tmp/pi-async-build.log"
	@docker build -t "$(IMAGE)" -f "$(TOOLS)/Dockerfile" "$(TOOLS)" 2>&1 \
	  | tee /tmp/pi-async-build.log | tail -3

up: ## 起冒烟容器（缺镜像先构建）
	@docker image inspect "$(IMAGE)" >/dev/null 2>&1 || $(MAKE) build
	@bash "$(TOOLS)/run-container.sh" --root "$(ROOT)" --image "$(IMAGE)" --model "$(MODEL)"

run: ## 起容器并直接进入 pi（默认 hy4-preview-ioa）—— 日常体验用这个
	@docker image inspect "$(IMAGE)" >/dev/null 2>&1 || $(MAKE) build
	@bash "$(TOOLS)/run-container.sh" --root "$(ROOT)" --image "$(IMAGE)" --model "$(MODEL)" --reuse
	@echo "进入 pi（model=$(MODEL)，容器 $(NAME)）…"
	@docker exec -it "$(NAME)" pi --model "$(MODEL)"

it: run ## run 的别名

smoke: ## 三层冒烟：模型可达 → 工具注册 → 工具真执行
	@bash "$(TOOLS)/smoke.sh" "$(MODEL)" "$(NAME)"

shell: ## 只进容器 bash（不自动跑 pi）
	@docker exec -it "$(NAME)" bash

status: ## 容器与镜像状态
	@docker ps -a --filter name=$(NAME) --filter name=$(QA_NAME) \
	  --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'
	@docker images --format '{{.Repository}}:{{.Tag}}\t{{.ID}}' \
	  | grep -E '$(IMAGE)' || echo "（镜像 $(IMAGE) 未构建）"

logs: ## 容器日志
	@docker logs --tail 50 $(NAME) 2>&1 \
	  || echo "（容器未起；CMD 是 sleep infinity，空日志属正常）"

down: clean
clean: ## 删冒烟容器（镜像保留，可复现）
	@docker rm -f $(NAME) >/dev/null 2>&1 && echo "已删 $(NAME)" || echo "$(NAME) 不存在"

# ---------------------------------------------------------------- TUI 回归

qa-up: ## 起/重建 TUI 容器（挂载 tools + scenarios + 源码）
	@docker rm -f $(QA_NAME) >/dev/null 2>&1 || true
	@docker run -d --name $(QA_NAME) \
	  -v $(ROOT):/mnt/pi-async:ro \
	  -v $(SCEN):/qa/scenarios:ro \
	  -v $(TOOLS):/qa/tools:ro \
	  $(IMAGE) >/dev/null
	@echo "已起 $(QA_NAME)"
	@echo "  $(ROOT)        → /mnt/pi-async (ro)"
	@echo "  $(SCEN) → /qa/scenarios (ro)"
	@echo "  $(TOOLS)  → /qa/tools     (ro)"

qa-tui: ## 跑一个 TUI 场景（SCENARIO=s1），产物 /qa/artifacts/<name>
	@bash "$(TOOLS)/run-scenario.sh" "$(SCENARIO)" "$(ROOT)" "$(QA_NAME)" "$(COLS)" "$(ROWS)"

qa-shell: ## 进 TUI 容器
	@docker exec -it $(QA_NAME) bash

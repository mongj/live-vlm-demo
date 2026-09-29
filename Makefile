PATH := /opt/pbs/bin:$(PATH)
export PATH

.DEFAULT_GOAL := help

.PHONY: help
help:
	@printf '%s\n' \
		'Usage: make <command>' \
		'' \
		'  help               Show this help (default)' \
		'  install            Create/reuse Conda environment and install dependencies' \
		'  server             Start gateway in screen live-vlm-server (port 8787)' \
		'  client             Start frontend in screen live-vlm-client (port 3001)' \
		'  down               Stop gateway and frontend' \
		'  joyai              Submit PBS job and print manual tunnel commands'

CONDA ?= conda
INSTALL_ENV := live-vlm-demo
CLIENT_HOST ?= 127.0.0.1
CLIENT_PORT ?= 3001

JOYAI_SCRIPT := $(CURDIR)/scripts/joyai.pbs
JOYAI_LOG := $(HOME)/live-vlm-demo/joyai/logs/pbs_joyai_web.log
JOYAI_WALLTIME ?= 01:00:00
JOYAI_MEM := 64gb
JOYAI_NGPUS := 3
JOYAI_NODES := cvml01 cvml03 cvml10 cvml11 cvml12

define JOYAI_PICK_JQ
def kb:
  ascii_downcase
  | capture("^(?<n>[0-9]+)(?<u>[a-z]*)$$") as $$c
  | ($$c.n | tonumber) * (
      if $$c.u == "gb" then 1048576
      elif $$c.u == "mb" then 1024
      elif $$c.u == "kb" then 1
      else 1 end
    );
def info($$n):
  .nodes[$$n] as $$node
  | $$node.resources_available as $$a
  | ($$node.resources_assigned // {}) as $$s
  | {
      name: $$n,
      state: $$node.state,
      gpu_free: ($$a.ngpus - ($$s.ngpus // 0)),
      gpu_total: $$a.ngpus,
      mem_free_kb: (($$a.mem | kb) - (($$s.mem // "0kb") | kb)),
      mem_total_kb: ($$a.mem | kb)
    };
($$order | split(" ")) as $$names
| [
    $$names[] as $$n
    | select(.nodes[$$n] != null)
    | info($$n)
    | select(.state == "free" and .gpu_free >= $$need_gpu and .mem_free_kb >= ($$need_mem | kb))
  ]
| if length == 0 then error("none") else .[0] end
| "\(.name) \(.state) \(.gpu_free)/\(.gpu_total) \((.mem_free_kb / 1048576) | floor)gb/\((.mem_total_kb / 1048576) | floor)gb"
endef
export JOYAI_PICK_JQ

define JOYAI_STATUS_JQ
($$order | split(" "))[] as $$n
| select(.nodes[$$n] != null)
| .nodes[$$n] as $$node
| $$node.resources_available as $$a
| ($$node.resources_assigned // {}) as $$s
| "\($$n)\tstate=\($$node.state)\tngpus=\($$a.ngpus - ($$s.ngpus // 0))/\($$a.ngpus)\tmem=\($$a.mem) assigned=\($$s.mem // "0")"
endef
export JOYAI_STATUS_JQ

.PHONY: joyai
joyai:
	@command -v pbsnodes >/dev/null && command -v qsub >/dev/null && command -v jq >/dev/null || { \
		echo "need pbsnodes, qsub, and jq on PATH; run this on caquelon" >&2; \
		exit 1; \
	}
	@json=$$(pbsnodes -a -F json) || exit 1; \
	printf '%s\n' "$$json" | jq -r --arg order "$(JOYAI_NODES)" "$$JOYAI_STATUS_JQ" || exit 1; \
	echo; \
	pick=$$(printf '%s\n' "$$json" | jq -er --arg order "$(JOYAI_NODES)" --argjson need_gpu $(JOYAI_NGPUS) --arg need_mem "$(JOYAI_MEM)" "$$JOYAI_PICK_JQ") || { \
		echo "no supported node has $(JOYAI_NGPUS) free GPUs and $(JOYAI_MEM) free RAM" >&2; \
		exit 1; \
	}; \
	set -- $$pick; \
	host=$$1; state=$$2; gpus=$$3; mem=$$4; \
	echo "selected $$host  state=$$state  ngpus(free/total)=$$gpus  mem(free/total)=$$mem"; \
	echo "qsub -N joyai_backend -j oe -o $(JOYAI_LOG) -l select=1:ngpus=$(JOYAI_NGPUS):mem=$(JOYAI_MEM):host=$$host -l walltime=$(JOYAI_WALLTIME) $(JOYAI_SCRIPT)"; \
	printf "submit? [y/N] "; \
	read -r ans </dev/tty; \
	case $$ans in \
		y|Y|yes|YES) ;; \
		*) echo "aborted"; exit 1 ;; \
	esac; \
	mkdir -p "$$(dirname "$(JOYAI_LOG)")" || exit 1; \
	job=$$(qsub -N joyai_backend -j oe -o "$(JOYAI_LOG)" \
		-l "select=1:ngpus=$(JOYAI_NGPUS):mem=$(JOYAI_MEM):host=$$host" \
		-l "walltime=$(JOYAI_WALLTIME)" "$(JOYAI_SCRIPT)") || exit 1; \
	echo "Submitted PBS job $$job on selected node $$host (may still be queued)."; \
	echo "Start the tunnel on this login/gateway host (requires SSH key access):"; \
	echo "  screen -dmS live-vlm-joyai-tunnel ssh -NT -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=10 -o ServerAliveCountMax=3 -o ControlMaster=no -o ControlPath=none -L 127.0.0.1:8070:127.0.0.1:8070 $$host"; \
	echo "Stop the tunnel:"; \
	echo "  screen -S live-vlm-joyai-tunnel -X quit"; \
	echo "Stop the PBS job separately:"; \
	echo "  qdel $$job"; \
	echo "Watch startup: tail -n 50 -F $(CURDIR)/joyai/logs/webinfer.log"


.PHONY: install
install:
	@command -v "$(CONDA)" >/dev/null || { echo "Conda is required; install it or set CONDA=/path/to/conda." >&2; exit 1; }
	@envs=$$("$(CONDA)" env list) || exit 1; \
	if printf '%s\n' "$$envs" | awk '$$1 == "$(INSTALL_ENV)" { found=1 } END { exit !found }'; then \
		echo "Reusing Conda environment $(INSTALL_ENV)"; \
	else \
		"$(CONDA)" env create -f "$(CURDIR)/environment.yml" -y || exit 1; \
	fi
	"$(CONDA)" run -n $(INSTALL_ENV) npm install --global corepack
	"$(CONDA)" run -n $(INSTALL_ENV) corepack enable
	"$(CONDA)" run -n $(INSTALL_ENV) corepack install --global yarn@4.9.2
	"$(CONDA)" run -n $(INSTALL_ENV) python -m pip install -e '$(CURDIR)/web-server[dev]'
	cd "$(CURDIR)/web-ui" && "$(CONDA)" run -n $(INSTALL_ENV) yarn install --immutable

.PHONY: server client
server:
	@bash "$(CURDIR)/scripts/start-screen.sh" live-vlm-server "$(CURDIR)/web-server" "$(CURDIR)/logs/server.screen.log" "$(CONDA)" run --no-capture-output -n $(INSTALL_ENV) python -m live_vlm_server

client:
	@bash "$(CURDIR)/scripts/start-screen.sh" live-vlm-client "$(CURDIR)/web-ui" "$(CURDIR)/logs/client.screen.log" "$(CONDA)" run --no-capture-output -n $(INSTALL_ENV) yarn dev --hostname "$(CLIENT_HOST)" --port "$(CLIENT_PORT)"

down:
	screen -S live-vlm-server -X quit
	screen -S live-vlm-client -X quit
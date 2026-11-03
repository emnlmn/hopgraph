# Short names for the npm scripts in package.json, which stay the source of truth (CI runs them).
# `make` alone lists the targets. Each target prints its name, then ✓ and the time it took, or ✗.

SHELL := /bin/bash
.DEFAULT_GOAL := help
.SILENT:
MAKEFLAGS += --no-print-directory
export npm_config_loglevel := silent
export PIP_DISABLE_PIP_VERSION_CHECK := 1
export PIP_QUIET := 1
.PHONY: help install setup tools check test props coverage lint format typecheck skill badge build api api-update \
	smoke bench example crap dry clean

# b, c, d, g, r, z: bold, cyan, dim, green, red, reset, set only on a terminal and never under NO_COLOR
COLORS = if [ -t 1 ] && [ -z "$${NO_COLOR+x}" ]; then b=$$'\033[1m'; c=$$'\033[36m'; d=$$'\033[2m'; g=$$'\033[32m'; r=$$'\033[31m'; z=$$'\033[0m'; fi

# $(call step,name,command): runs command under a header; colour only on a terminal, never under NO_COLOR
define step
	t0=$$(perl -MTime::HiRes=time -e 'print time'); \
	$(COLORS); \
	printf '%s▸ %s%s\n' "$$b" '$(1)' "$$z"; \
	if $(2); then printf '%s✓%s %s %s%ss%s\n\n' "$$g" "$$z" '$(1)' "$$d" "$$(perl -MTime::HiRes=time -e "printf q(%.1f), time - $$t0")" "$$z"; \
	else s=$$?; printf '%s✗ %s%s\n' "$$r" '$(1)' "$$z"; exit $$s; fi
endef

help: ## List the targets
	$(COLORS); printf '\n  %shopgraph%s  %smake <target>%s\n\n' "$$b" "$$z" "$$d" "$$z"; \
	grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | while IFS= read -r line; do \
	  printf '  %s%-11s%s %s\n' "$$c" "$${line%%:*}" "$$z" "$${line#*## }"; done; echo

install: ## Install the dependencies from the lockfile
	$(call step,install,npm ci --no-audit --no-fund)

check: typecheck skill lint badge coverage props build api smoke ## Everything CI runs, step by step
	$(COLORS); printf '%s✓ check passed%s\n' "$$g$$b" "$$z"

test: ## Unit tests
	$(call step,test,npx vitest run --project unit)

props: ## Property tests (HOPGRAPH_SEED=random for a new seed)
	$(call step,props,npm run test:props)

coverage: ## Unit tests with the coverage thresholds
	$(call step,coverage,npm run coverage)

lint: ## Biome
	$(call step,lint,npm run lint)

format: ## Biome, applying its fixes
	$(call step,format,npx biome check --write .)

typecheck: ## TypeScript, no emit
	$(call step,typecheck,npm run typecheck)

skill: ## The code in skills/hopgraph/SKILL.md compiles
	$(call step,skill,npm run skill)

badge: ## The README coverage badge matches the threshold
	$(call step,badge,npm run badge)

build: ## Compile to dist/
	$(call step,build,npm run build)

api: build ## Compare the public API with api/hopgraph.api.md
	$(call step,api,npm run api)

api-update: ## Rewrite the API report and docs/api after an intended API change
	$(call step,api-update,npm run api:update)

smoke: build ## Import and run the build
	$(call step,smoke,npm run smoke)

bench: build ## Executor overhead and latency (--markdown for bench/README.md)
	$(call step,bench,node --expose-gc bench/run.ts $(ARGS))
	$(call step,latency,node bench/latency.ts $(ARGS))

example: build ## Run the three examples
	$(call step,playlist,node examples/playlist.ts)
	$(call step,sql,node examples/sql.ts)
	$(call step,warehouse,node examples/warehouse.ts)

# crapper, dryer and mutator (github.com/unclebob) are not npm dependencies: `make setup` clones
# them into .tools/ at the commits below, and each makes its own .venv on first run (needs git and
# python3). Bump a commit to update a tool.
TOOLS := .tools
REV_crapper := 6fd92c4c9bcc56efb64a2f8743d5a2993bcfd42d
REV_dryer := 66ff6d21a42c04afcad89c78a80066176d1294b0
REV_mutator := a5a0cb803b66e0cdb8bf471b3b08af701d424a41

setup: install tools ## Everything a fresh clone needs: npm ci, then the tools

tools: ## crapper, dryer and mutator in .tools/, at pinned commits
	$(call step,tools,$(MAKE) $(TOOLS)/crapper/.venv $(TOOLS)/dryer/.venv $(TOOLS)/mutator/.venv)

$(TOOLS)/%/.venv:
	rm -rf $(TOOLS)/$*
	git clone -q https://github.com/unclebob/$*.git $(TOOLS)/$*
	git -C $(TOOLS)/$* -c advice.detachedHead=false checkout -q $(REV_$*)
	$(TOOLS)/$*/$* --help >/dev/null

crap: $(TOOLS)/crapper/.venv ## CRAP score per function, with line coverage
	$(call step,coverage,npx vitest run --project unit --coverage --coverage.reporter=lcov >/dev/null)
	$(call step,crap,$(TOOLS)/crapper/crapper --use-existing-coverage src)

dry: $(TOOLS)/dryer/.venv ## Candidate duplicate code
	$(call step,dry,$(TOOLS)/dryer/dryer src)

clean: ## Remove build, coverage and metrics output
	$(call step,clean,rm -rf dist coverage temp .metrics)

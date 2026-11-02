# Short names for the npm scripts in package.json, which stay the source of truth (CI runs them).
# `make` alone lists the targets. Each target prints its name, then ✓ and the time it took, or ✗.

SHELL := /bin/bash
.DEFAULT_GOAL := help
.SILENT:
MAKEFLAGS += --no-print-directory
export npm_config_loglevel := silent
.PHONY: help install check test props coverage lint format typecheck badge build api api-update \
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

check: typecheck lint badge coverage props build api smoke ## Everything CI runs, step by step
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

# crapper and dryer are separate tools (github.com/unclebob/crapper, /dryer), not dependencies
crap: ## CRAP score per function, with line coverage (needs crapper)
	$(call step,coverage,npx vitest run --project unit --coverage --coverage.reporter=lcov >/dev/null)
	$(call step,crap,crapper --use-existing-coverage src)

dry: ## Candidate duplicate code (needs dryer)
	$(call step,dry,dryer src)

clean: ## Remove build, coverage and metrics output
	$(call step,clean,rm -rf dist coverage temp .metrics)

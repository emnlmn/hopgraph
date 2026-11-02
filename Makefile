# Short names for the npm scripts in package.json, which stay the source of truth (CI runs them).
# `make` alone lists the targets.

.DEFAULT_GOAL := help
.PHONY: help install check test props coverage lint format typecheck build api api-update \
	bench example crap dry clean

help: ## List the targets
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{ printf "  %-11s %s\n", $$1, $$2 }'

install: ## Install the dependencies from the lockfile
	npm ci

check: ## Everything CI runs: types, lint, badge, coverage, props, build, API, smoke
	npm run check

test: ## Unit tests
	npm test

props: ## Property tests (HOPGRAPH_SEED=random for a new seed)
	npm run test:props

coverage: ## Unit tests with the coverage thresholds
	npm run coverage

lint: ## Biome
	npm run lint

format: ## Biome, applying its fixes
	npx biome check --write .

typecheck: ## TypeScript, no emit
	npm run typecheck

build: ## Compile to dist/
	npm run build

api: ## Compare the public API with api/hopgraph.api.md
	npm run api

api-update: ## Rewrite the API report and docs/api after an intended API change
	npm run api:update

bench: ## Executor overhead and latency benchmarks
	npm run bench && npm run bench:latency

example: ## Run the three examples
	npm run example && npm run example:sql && npm run example:warehouse

# crapper and dryer are separate tools (github.com/unclebob/crapper, /dryer), not dependencies
crap: ## CRAP score per function, with line coverage (needs crapper)
	npx vitest run --project unit --coverage --coverage.reporter=lcov
	crapper --use-existing-coverage src

dry: ## Candidate duplicate code (needs dryer)
	dryer src

clean: ## Remove build, coverage and metrics output
	rm -rf dist coverage temp .metrics

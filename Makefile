.PHONY: cli build

# Build the laptop CLI and install the infinite command.
cli: node_modules
	npm run build -w @infinite/attention
	npm run build -w @infinite/host
	node scripts/install-client.mjs

build: cli

node_modules: package.json package-lock.json
	npm ci
	touch $@

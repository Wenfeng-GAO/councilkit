.PHONY: update build test lint

# 更新到最新代码并重装、重建 CLI(自用日常维护入口)
update:
	git pull
	pnpm install --frozen-lockfile
	pnpm build:cli

build:
	pnpm build:cli

test:
	pnpm test:unit

lint:
	pnpm lint

# Deploys broadcast with the Foundry keystore `omni-deployer`; set DEPLOYER to its address and the inputs each
# script documents (see contracts/.env.example). No private key is ever passed on the command line.
ACCOUNT ?= omni-deployer
FORGE_BROADCAST = --account $(ACCOUNT) --sender $(DEPLOYER) --broadcast
# Lasna rejects any transaction whose fee cap exceeds 1 ether; forge's default (twice the base fee on a
# multi-million gas limit) crosses it. The Reactive-side scripts also refuse to run above 100 gwei on Lasna.
REACTIVE_GAS_PRICE ?= 100gwei
REACTIVE_GAS = --with-gas-price $(REACTIVE_GAS_PRICE)

.PHONY: build test fmt deploy-reactive deploy-till wire invoice cli-test

build:
	cd contracts && forge build

test:
	cd contracts && forge test
	cd scripts && pnpm install --frozen-lockfile && pnpm typecheck && pnpm test

fmt:
	cd contracts && forge fmt

deploy-reactive:
	cd contracts && forge script script/DeployReactive.s.sol --rpc-url $(REACTIVE_RPC) $(REACTIVE_GAS) $(FORGE_BROADCAST)

deploy-till:
	cd contracts && forge script script/DeployTill.s.sol --rpc-url $(CHAIN_RPC) $(FORGE_BROADCAST)

wire:
	cd contracts && forge script script/Wire.s.sol --rpc-url $(REACTIVE_RPC) $(REACTIVE_GAS) $(FORGE_BROADCAST)

invoice:
	cd contracts && forge script script/CreateInvoice.s.sol --rpc-url $(REACTIVE_RPC) $(REACTIVE_GAS) $(FORGE_BROADCAST)

# CI, locally: the steps of .github/workflows/ci.yml in the same order. Only the artifact uploads and the
# Playwright run against the Vercel preview (preview-e2e.yml) are GitHub-only; `make smoke` runs the latter
# against any URL.
CI_NODE_WORKSPACES := web scripts
BASE_RPC_URL ?= https://mainnet.base.org
SLITHER_JSON ?= $(or $(TMPDIR),/tmp)/daybook-slither.json
SMOKE_URL ?= https://daybook-omni.vercel.app
.PHONY: ci ci-writing ci-secrets ci-contracts ci-slither ci-node smoke

ci: ci-writing ci-secrets ci-contracts ci-slither ci-node

ci-writing:
	node --test tools/check-writing.test.mjs
	node tools/check-writing.mjs

ci-secrets:
	gitleaks git --redact --no-banner --exit-code 1 .

ci-contracts:
	cd contracts && forge fmt --check
	cd contracts && forge build
	cd contracts && forge test --no-match-contract Fork
	cd contracts && BASE_RPC_URL=$(BASE_RPC_URL) forge test --match-contract Fork
	cd contracts && forge coverage --report summary \
		--no-match-contract "Fork|CodeSize" --no-match-coverage "(test|script|lib)/"

ci-slither:
	rm -f $(SLITHER_JSON)
	cd contracts && slither . --config-file ../slither.config.json --json $(SLITHER_JSON)
	node tools/slither-gate.mjs $(SLITHER_JSON) tools/slither-triage.json

ci-node:
	for w in $(CI_NODE_WORKSPACES); do \
		echo "== $$w"; \
		(cd $$w && pnpm install --frozen-lockfile --allow-build esbuild && pnpm run --if-present lint && \
			{ [ ! -f next.config.ts ] || pnpm exec next typegen; } && pnpm run typecheck && pnpm run test) || exit 1; \
	done

smoke:
	cd tools/smoke && pnpm install --frozen-lockfile && \
		SMOKE_URL=$(SMOKE_URL) SMOKE_TITLE=Daybook SMOKE_TEXT=paid pnpm run test

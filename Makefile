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

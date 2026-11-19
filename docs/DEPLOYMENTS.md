# Deployments

Testnet only. All contracts are owned by the deployer `0x4d96Ec766088D952D62255227902eeEe1C58276c` (Foundry keystore `omni-deployer`). Explorers: [lasna.reactscan.net](https://lasna.reactscan.net), [sepolia.basescan.org](https://sepolia.basescan.org), [unichain-sepolia.blockscout.com](https://unichain-sepolia.blockscout.com). Sourcify links use `https://repo.sourcify.dev/<chainId>/<address>`.

## Current: v1 (commit `adfc5a8`, security fixes)

Split policy 1: treasury = deployer, tax 15% to the chain's SavingsVault, team 20% to `0xDb7e885B6b9EB7975f2E49794c09e3b0674940E2` and 10% to `0xb393f5064cD8072FB97dAFbC56dFEe195D78C133`. The two team addresses are fresh test recipients made with `cast wallet new`; only the addresses were kept, so anything sent to them is unrecoverable test money. Cron tier: Cron100. `maxInvoiceAmount` set to 20 USDC to match the till caps.

### Reactive Lasna (5318007)

| Contract | Address | Deploy tx | Sourcify |
|---|---|---|---|
| DaybookReactive | [`0x182BA62E240433B54136712d8840Ccc354bb78d3`](https://lasna.reactscan.net/address/0x182BA62E240433B54136712d8840Ccc354bb78d3) | [`0x55634cae…5369`](https://lasna.reactscan.net/tx/0x55634caeec6d0ec849a3f190ae50c037530ae23ffd452aa740a10ceafe9e5369) (5,023,533 gas, funded 0.6 lREACT) | [exact_match](https://repo.sourcify.dev/5318007/0x182BA62E240433B54136712d8840Ccc354bb78d3) |

Wiring: setTill 84532 [`0x85a1638f…3114`](https://lasna.reactscan.net/tx/0x85a1638f5d1df7c01d1e8f147e6c7842f705b81c5d87ba6adf3a4e053d5c3114), setTill 1301 [`0x26bc40fc…a059`](https://lasna.reactscan.net/tx/0x26bc40fcb943e5152f596684b8ca12836aedc2117c009da7bee1c8315d2da059), createPolicy [`0xf5e4e24c…b6f8`](https://lasna.reactscan.net/tx/0xf5e4e24c0e1dc535bfd208808af7aa65159295ba47b94769e5e1d57d0cc6b5f8), setMaxInvoiceAmount [`0xfd673218…aaef`](https://lasna.reactscan.net/tx/0xfd6732182433fee27f201deb27660bba6febd4d885515ecc5fd714cc1c35aaef).

### Same address on both payment chains

| Contract | Address | Base Sepolia | Unichain Sepolia |
|---|---|---|---|
| PayAddressFactory (via-IR build, see below) | `0xA7984241CC7596B0ED7C3b71409Bda7cf6E0D33c` | [tx](https://sepolia.basescan.org/tx/0x0a29b23eeba73b1808ab79d9ba4505afbb271414e83e268cd6de04681d8340e4), [Sourcify exact](https://repo.sourcify.dev/84532/0xA7984241CC7596B0ED7C3b71409Bda7cf6E0D33c) | [tx](https://unichain-sepolia.blockscout.com/tx/0x03f6d050004ee50ac54a8e3d97295ee982063a1e0067ad617d36c8f44014732c), [Sourcify exact](https://repo.sourcify.dev/1301/0xA7984241CC7596B0ED7C3b71409Bda7cf6E0D33c) |
| InvoiceVault implementation | `0xCDE82FE77A96C255154341A6839cDEfe71f6e348` | [Sourcify exact](https://repo.sourcify.dev/84532/0xCDE82FE77A96C255154341A6839cDEfe71f6e348) | [Sourcify exact](https://repo.sourcify.dev/1301/0xCDE82FE77A96C255154341A6839cDEfe71f6e348) |

Both factories went out as raw calls to the CREATE2 deployer `0x4e59…956C` with salt `keccak256("daybook.pay-address-factory.v1")` and the via-IR init code (`forge inspect PayAddressFactory bytecode --via-ir`), because that is the factory the v1 reactive contract predicted.

### Base Sepolia (84532)

| Contract | Address | Sourcify |
|---|---|---|
| DaybookTill | [`0x4Bd6fE154dF715608eE3294BB3EcA4028703bba9`](https://sepolia.basescan.org/address/0x4Bd6fE154dF715608eE3294BB3EcA4028703bba9) ([tx](https://sepolia.basescan.org/tx/0x783d50bdb226522eca835a9a49ff990ff3a4dc63b07a3a20cfb7ee53d98080aa)) | [exact_match](https://repo.sourcify.dev/84532/0x4Bd6fE154dF715608eE3294BB3EcA4028703bba9) |
| SavingsVault | [`0xb444ca6477cc594E35a5676d5f7ABa51E7c5CC26`](https://sepolia.basescan.org/address/0xb444ca6477cc594E35a5676d5f7ABa51E7c5CC26) | [exact_match](https://repo.sourcify.dev/84532/0xb444ca6477cc594E35a5676d5f7ABa51E7c5CC26) |
| EasReceiptIssuer | [`0xf36c602e30828881A9Aa46782fAB974584807e36`](https://sepolia.basescan.org/address/0xf36c602e30828881A9Aa46782fAB974584807e36) | [exact_match](https://repo.sourcify.dev/84532/0xf36c602e30828881A9Aa46782fAB974584807e36) |

Configuration: factory.setTill [`0xcac83e73…e83b`](https://sepolia.basescan.org/tx/0xcac83e73a1fb97cfc34f044848c3c688397737ec3dee6152e69a863f4b19e83b), setReserve [`0xab3c107e…897e`](https://sepolia.basescan.org/tx/0xab3c107ef31b993d3fc1c724d29112b26cd118f292ec60fe706e81b996d0897e), setMaxSettlement(USDC, 20e6) [`0x2430499b…a19f`](https://sepolia.basescan.org/tx/0x2430499b75127cb667f6fae1f6a489268b65ce25db6f3dd1ac576ef4a19ba19f), setReceiptIssuer [`0xa10e4956…c0f4`](https://sepolia.basescan.org/tx/0xa10e4956c927ac44b0a4551bd5a9a1b4882bfdfc26b836b527351c98f941c0f4). Proxy deposit 0.001 ETH [`0xc2a6ea4c…0d10`](https://sepolia.basescan.org/tx/0xc2a6ea4c6b307ccdd3882d332c32a9bfe9346c2bbe045549d8935adc717b0d10).

### Unichain Sepolia (1301)

| Contract | Address | Sourcify |
|---|---|---|
| DaybookTill | [`0xAea11aFA4f56f8f7952cE543Ea49421D70d5EFCf`](https://unichain-sepolia.blockscout.com/address/0xAea11aFA4f56f8f7952cE543Ea49421D70d5EFCf) ([tx](https://unichain-sepolia.blockscout.com/tx/0x7c2583ae8f2f2da6a11813aa984a313ca2514d0cbc91154f379d6d648260f1d3)) | [exact_match](https://repo.sourcify.dev/1301/0xAea11aFA4f56f8f7952cE543Ea49421D70d5EFCf) |
| SavingsVault | [`0xc03A2Ce7cc50B940f063eA39FBbFE51bf1750668`](https://unichain-sepolia.blockscout.com/address/0xc03A2Ce7cc50B940f063eA39FBbFE51bf1750668) | [exact_match](https://repo.sourcify.dev/1301/0xc03A2Ce7cc50B940f063eA39FBbFE51bf1750668) |
| EasReceiptIssuer | [`0x0c1eA9879bFEa9Ce280D2bdb1b7755989d2D64aE`](https://unichain-sepolia.blockscout.com/address/0x0c1eA9879bFEa9Ce280D2bdb1b7755989d2D64aE) | [exact_match](https://repo.sourcify.dev/1301/0x0c1eA9879bFEa9Ce280D2bdb1b7755989d2D64aE) |

Configuration: factory.setTill [`0x62a90774…1b6d`](https://unichain-sepolia.blockscout.com/tx/0x62a90774ce473f2e89eeaf050252d7401369d9dccd1bbba08871c1d07a8f1b6d), setReserve [`0xe22d17c0…9816`](https://unichain-sepolia.blockscout.com/tx/0xe22d17c09db61b6850181c5f633c5d9f5a8a2f40403e5837e4c98a44ef269816), setMaxSettlement [`0x2501d933…bf57`](https://unichain-sepolia.blockscout.com/tx/0x2501d933b064ab949128b5e1e105e896d6973946aeb866f7778e28adb111bf57), setReceiptIssuer [`0x53f41429…7e13`](https://unichain-sepolia.blockscout.com/tx/0x53f414293516c6aa7109a0cde17865f678e28c1740aaa7d2b551278602f07e13). Proxy deposit 0.001 ETH [`0xb1344e56…94a1`](https://unichain-sepolia.blockscout.com/tx/0xb1344e56c6a8a234b993e1357c5dde66a5b163ee8d608b9727c90764bc9b94a1).

Watch out: the Unichain v1 till and vault addresses equal the superseded v1-a till and vault on **Base** (same deployer nonces). Always read an address together with its chain.

### Shared test fixtures

| Item | Where | Value |
|---|---|---|
| EAS schema `uint256 invoiceId,uint256 seq,address token,uint256 amount,uint256 chainId` (no resolver, not revocable) | Base Sepolia and Unichain Sepolia | UID `0xd919a1309ca1e916e4cdd6224c62c6f5eda74f2982253e0d96143a9abffdf317`; registered in [Base tx](https://sepolia.basescan.org/tx/0x347459b7bdd38da7a3a08ab4f2575572ee7bb811aa3b8ba31a3632afc6ed26c3), [Unichain tx](https://unichain-sepolia.blockscout.com/tx/0xffefc7e787f657bd75a0cdc171478fda5d91d1fe83bfba983755eda97ef032d0) |
| DBKTEST (MockERC20, 6 decimals, open mint) for wrong-token tests | Base Sepolia | [`0xBF1Bfc97f7cf822113D41922c92910eAC925Dee7`](https://sepolia.basescan.org/address/0xBF1Bfc97f7cf822113D41922c92910eAC925Dee7), [Sourcify exact](https://repo.sourcify.dev/84532/0xBF1Bfc97f7cf822113D41922c92910eAC925Dee7) |
| DoubleSubProbe (measurement only, closed and unsubscribed) | Lasna | [`0x2C10E554FdAb44E2D85407457584b94c3CEebA05`](https://lasna.reactscan.net/address/0x2C10E554FdAb44E2D85407457584b94c3CEebA05), not verified (source in docs/FIRST_LOOPS.md) |

## Superseded

### v1-a (commit `adfc5a8`), never used: wrong factory

The `DeployTill` script deployed a legacy-pipeline factory at `0xAa4AaE051a408eb6DEB491A1D2523E8d69ED1D04`, but the v1 reactive contract had predicted the via-IR factory `0xA798…D33c` (see DECISIONS.md, 2026-11-19, factory prediction). Pay addresses from this factory are not the ones the reactive contract watches, so nothing was ever paid through it.

| Chain | Contract | Address |
|---|---|---|
| Base Sepolia | PayAddressFactory (legacy build) | [`0xAa4AaE051a408eb6DEB491A1D2523E8d69ED1D04`](https://sepolia.basescan.org/address/0xAa4AaE051a408eb6DEB491A1D2523E8d69ED1D04) |
| Base Sepolia | DaybookTill | [`0xAea11aFA4f56f8f7952cE543Ea49421D70d5EFCf`](https://sepolia.basescan.org/address/0xAea11aFA4f56f8f7952cE543Ea49421D70d5EFCf) |
| Base Sepolia | SavingsVault | [`0xc03A2Ce7cc50B940f063eA39FBbFE51bf1750668`](https://sepolia.basescan.org/address/0xc03A2Ce7cc50B940f063eA39FBbFE51bf1750668) |
| Base Sepolia | EasReceiptIssuer | [`0x2edc3FC05EcaA02dB18eeF5d5C581E5Be4a3a37D`](https://sepolia.basescan.org/address/0x2edc3FC05EcaA02dB18eeF5d5C581E5Be4a3a37D) |
| Unichain Sepolia | PayAddressFactory (legacy build, created by hand before the mismatch was found) | [`0xAa4AaE051a408eb6DEB491A1D2523E8d69ED1D04`](https://unichain-sepolia.blockscout.com/address/0xAa4AaE051a408eb6DEB491A1D2523E8d69ED1D04) ([tx](https://unichain-sepolia.blockscout.com/tx/0x990bf1c02396dd2e26f5f8c8e6f410ed1d0c2af3f82f2d1e73eb63122a837c61)) |

All Base v1-a contracts are Sourcify exact_match. The Base till holds no reserves at the proxy.

### v0 (commit `d8b866b`), superseded by the security fixes

Replaced because of SECURITY_REVIEW.md (H-1: default watch mode let anyone drain lREACT with fake Transfers; M-3: 250k receipt gas too low for a real EAS attestation, confirmed live, see FIRST_LOOPS.md). One loop was run on it. The reactive contract still holds 0.0302 lREACT and its four till subscriptions; its invoice 1 is Settled and unsubscribed.

| Chain | Contract | Address | Sourcify |
|---|---|---|---|
| Lasna | DaybookReactive | [`0x16d3b2d6e397B9b047eaec44e3d23ac016f462f0`](https://lasna.reactscan.net/address/0x16d3b2d6e397B9b047eaec44e3d23ac016f462f0) ([tx](https://lasna.reactscan.net/tx/0x496fbf0db541200a87ef8a1bad935d9f89cac1b931dbb704d36722a3320aecb7), 4,883,530 gas) | [exact_match](https://repo.sourcify.dev/5318007/0x16d3b2d6e397B9b047eaec44e3d23ac016f462f0) |
| Base + Unichain | PayAddressFactory | `0x76c0f35aB702D1c457766a4d9afE96dD960852C9` | Base exact; Unichain failed (`bytecode_length_mismatch` on byte-identical code, Sourcify side) |
| Base + Unichain | InvoiceVault implementation | `0x6fe8836e7519bb38ABB5Bcf90C699dA4E72f9D08` | Base exact; Unichain match |
| Base + Unichain | DaybookTill | `0xA4294ae5531Fc2C6d846bD2310cd242eB4e6Bda6` | Base exact; Unichain failed (as above) |
| Base + Unichain | SavingsVault | `0xfAaD47FA1084B2DF56Cc9C64BE416ec9Fb90A5E4` | Base exact; Unichain failed (as above) |
| Base + Unichain | EasReceiptIssuer | `0x5892a935d509ba8cD848e45a4E8Db4636Ea974Dc` | exact on both |

v0 proxy deposits: Base 0.002 ETH ([tx](https://sepolia.basescan.org/tx/0xc9db99b5543fdc5772d5a21113955d5c74bef8cfd31681e05cf7b52055f1bba1)), Unichain 0.001 ETH ([tx](https://unichain-sepolia.blockscout.com/tx/0x9648dd135843e590bcb9843e5e164bf688d2ba02da812c2796adbfcb450158f6)). Both are stranded at the proxies; there is no withdrawal from proxy reserves. v0 wiring txs: [`0x9bec4502…0e12`](https://lasna.reactscan.net/tx/0x9bec450274a0812c0e89752c3aa7bac5667e9337fdb9440206969ec918380e12), [`0x893bec46…914a`](https://lasna.reactscan.net/tx/0x893bec4612d803e2e83c6e5a54e197d45f23f5da8854f07f4e6e634b33dc914a), [`0xff60cd97…9cd7`](https://lasna.reactscan.net/tx/0xff60cd97774fa2a00f54814d979909fa3db9b76229933d9da257392660b29cd7). 0.9 lREACT withdrawn back to the deployer: [`0x66671218…eeee`](https://lasna.reactscan.net/tx/0x666712187894a52440f80234d58d49354fa76e7ac32ae0a32632744fac93eeee).

## lREACT accounting

Deployer start 4.725 lREACT. At the end of the first loops: deployer 2.745267, v1 RC 0.151991, v0 RC 0.030204. **Net consumed 1.797538 lREACT** (cap 2.5), of which: RC deploys 0.9908 (v0 0.4884, v1 0.5024); wiring and admin txs 0.0740 (v0 wire 0.0291, v1 wire 0.0339, setMaxInvoiceAmount 0.0030, v0 withdraw 0.0033, probe close 0.0047); invoice creation and the probe deploy 0.2017 (v0 invoice 0.0362, five v1 invoices 0.1121, probe 0.0534); reactions charged to the contracts 0.5310 (v0 0.0698, v1 0.4480, probe 0.0134). Per-loop figures are in FIRST_LOOPS.md.

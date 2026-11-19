// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { IPayable } from "@reactive/src/interfaces/IPayable.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { OmniHarness } from "./OmniHarness.sol";
import { MockCallbackProxy } from "./MockCallbackProxy.sol";
import { MockERC20 } from "../mocks/MockERC20.sol";
import { DaybookReactive } from "../../src/DaybookReactive.sol";
import { DaybookTill } from "../../src/DaybookTill.sol";
import { PayAddressFactory } from "../../src/PayAddressFactory.sol";
import { SavingsVault } from "../../src/SavingsVault.sol";
import { AcceptedToken, Recipient } from "../../src/DaybookTypes.sol";

/// @notice Full Daybook deployment on three simulated payment chains plus Reactive, all in one EVM.
/// Chain A and B use 6-decimal USDC, chain C an 18-decimal stablecoin, so normalization is exercised.
/// One factory serves all three simulated chains: in one EVM a pay address can only be one account, and the
/// chains stay separate because each has its own token contracts and its own till.
abstract contract DaybookFixture is OmniHarness {
    uint256 internal constant CHAIN_A = 84_532; // Base Sepolia
    uint256 internal constant CHAIN_B = 1301; // Unichain Sepolia
    uint256 internal constant CHAIN_C = 11_155_111; // Ethereum Sepolia
    uint256 internal constant CAP = 1_000_000e6;
    uint16 internal constant TAX_BPS = 2500;
    uint16 internal constant TEAM1_BPS = 1000;
    uint16 internal constant TEAM2_BPS = 500;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal team1 = makeAddr("team1");
    address internal team2 = makeAddr("team2");
    address internal payer = makeAddr("payer");
    address internal payer2 = makeAddr("payer2");

    PayAddressFactory internal factory;
    DaybookReactive internal reactive;
    uint32 internal policyId;

    mapping(uint256 chainId => DaybookTill) internal tillOn;
    mapping(uint256 chainId => SavingsVault) internal reserveOn;
    mapping(uint256 chainId => MockERC20) internal usd; // the accepted stablecoin on each chain
    MockERC20 internal junkA; // a token nobody accepts, on chain A

    function setUp() public virtual {
        _installSystem();
        vm.warp(1_800_000_000);
        factory = new PayAddressFactory(owner);
        reactive = new DaybookReactive{ value: 1 ether }(owner, address(factory), CRON100);

        _deployChain(CHAIN_A, "USDC", 6);
        _deployChain(CHAIN_B, "USDC", 6);
        _deployChain(CHAIN_C, "USDS", 18);
        junkA = new MockERC20("JUNK", 6);
        _registerEmitter(address(junkA), CHAIN_A);

        Recipient[] memory team = new Recipient[](2);
        team[0] = Recipient(team1, TEAM1_BPS);
        team[1] = Recipient(team2, TEAM2_BPS);
        vm.prank(owner);
        policyId = reactive.createPolicy(treasury, TAX_BPS, team);
        _flush();
    }

    function _deployChain(uint256 chainId, string memory symbol, uint8 decimals) internal {
        MockCallbackProxy proxy = new MockCallbackProxy(chainId == CHAIN_C ? 200_000 : 130_000);
        proxyOf[chainId] = proxy;
        DaybookTill till = new DaybookTill(IPayable(payable(address(proxy))), address(reactive), factory, owner);
        SavingsVault reserve = new SavingsVault(owner);
        MockERC20 token = new MockERC20(symbol, decimals);
        vm.startPrank(owner);
        factory.setTill(address(till), true);
        till.setReserve(reserve);
        till.setMaxSettlement(IERC20(address(token)), decimals == 6 ? CAP : CAP * 1e12);
        reactive.setTill(chainId, address(till));
        vm.stopPrank();
        tillOn[chainId] = till;
        reserveOn[chainId] = reserve;
        usd[chainId] = token;
        _registerEmitter(address(token), chainId);
        _registerEmitter(address(till), chainId);
    }

    // ----------------------------------------------------------------- helpers

    function _accept(uint256 chainId) internal view returns (AcceptedToken memory) {
        return AcceptedToken(uint64(chainId), address(usd[chainId]), usd[chainId].decimals());
    }

    function _acceptAB() internal view returns (AcceptedToken[] memory acc) {
        acc = new AcceptedToken[](2);
        acc[0] = _accept(CHAIN_A);
        acc[1] = _accept(CHAIN_B);
    }

    function _acceptABC() internal view returns (AcceptedToken[] memory acc) {
        acc = new AcceptedToken[](3);
        acc[0] = _accept(CHAIN_A);
        acc[1] = _accept(CHAIN_B);
        acc[2] = _accept(CHAIN_C);
    }

    function _params(uint256 amount, AcceptedToken[] memory acc, uint64 dueAt, uint64 expiresAt, bool strict)
        internal
        view
        returns (DaybookReactive.CreateInvoiceParams memory)
    {
        return DaybookReactive.CreateInvoiceParams({
            amount: amount,
            dueAt: dueAt,
            expiresAt: expiresAt,
            policyId: policyId,
            strictTokens: strict,
            detailsHash: keccak256("invoice details"),
            accepted: acc
        });
    }

    function _create(uint256 amount, AcceptedToken[] memory acc, uint64 dueAt, uint64 expiresAt, bool strict)
        internal
        returns (uint256 id)
    {
        vm.prank(owner);
        id = reactive.createInvoice(_params(amount, acc, dueAt, expiresAt, strict));
        _flush();
    }

    /// @notice A plain invoice: `amount` micro-dollars, payable on A and B, no due date, wildcard watching.
    function _createAB(uint256 amount) internal returns (uint256) {
        return _create(amount, _acceptAB(), 0, 0, false);
    }

    /// @notice An origin-chain transfer from `from` to `to`, relayed through the harness.
    function _pay(MockERC20 token, address from, address to, uint256 amount) internal {
        token.mint(from, amount);
        _flush();
        vm.prank(from);
        token.transfer(to, amount);
        _relayRecorded();
    }

    function _payInvoice(uint256 chainId, uint256 invoiceId, uint256 amount) internal {
        _pay(usd[chainId], payer, reactive.payAddressOf(invoiceId), amount);
    }

    function _status(uint256 id) internal view returns (DaybookReactive.InvoiceStatus) {
        return reactive.getInvoice(id).status;
    }

    function _warpTick(uint256 secondsAhead) internal {
        vm.warp(block.timestamp + secondsAhead);
        vm.roll(block.number + secondsAhead);
        _cronTick();
    }

    /// @notice Total of `token` held across the treasury, team, reserve and the till's own balance.
    function _paidOut(uint256 chainId) internal view returns (uint256) {
        MockERC20 t = usd[chainId];
        return
            t.balanceOf(treasury) + t.balanceOf(team1) + t.balanceOf(team2) + t.balanceOf(address(reserveOn[chainId]));
    }
}

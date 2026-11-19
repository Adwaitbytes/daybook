// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { Test } from "forge-std/Test.sol";
import { IPayable } from "@reactive/src/interfaces/IPayable.sol";
import { AbstractPayer } from "@reactive/src/base/AbstractPayer.sol";
import { AbstractCallback } from "@reactive/src/base/AbstractCallback.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Pausable } from "@openzeppelin/contracts/utils/Pausable.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { DaybookTill } from "../src/DaybookTill.sol";
import { PayAddressFactory } from "../src/PayAddressFactory.sol";
import { SavingsVault } from "../src/SavingsVault.sol";
import { EasReceiptIssuer, IEAS } from "../src/EasReceiptIssuer.sol";
import { IDaybookTill } from "../src/interfaces/IDaybookTill.sol";
import { IReserve } from "../src/interfaces/IReserve.sol";
import { IReceiptIssuer } from "../src/interfaces/IReceiptIssuer.sol";
import { DaybookLib, Recipient, SplitPolicy } from "../src/DaybookTypes.sol";
import { MockERC20 } from "./mocks/MockERC20.sol";
import { GasBurningIssuer, MockEAS, RevertingIssuer, RevertingReserve, ShortPullReserve } from "./mocks/Mocks.sol";

/// @notice Till unit tests, calling `settle` directly as the callback proxy would.
contract DaybookTillTest is Test {
    address internal proxy = makeAddr("proxy");
    address internal rc = makeAddr("reactive");
    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal team1 = makeAddr("team1");
    address internal team2 = makeAddr("team2");
    address internal payer = makeAddr("payer");

    PayAddressFactory internal factory;
    DaybookTill internal till;
    SavingsVault internal reserve;
    MockERC20 internal usdc;

    function setUp() public {
        factory = new PayAddressFactory(owner);
        till = new DaybookTill(IPayable(payable(proxy)), rc, factory, owner);
        reserve = new SavingsVault(owner);
        usdc = new MockERC20("USDC", 6);
        vm.startPrank(owner);
        factory.setTill(address(till), true);
        till.setReserve(reserve);
        till.setMaxSettlement(IERC20(address(usdc)), 1_000_000e6);
        vm.stopPrank();
    }

    function _policy() internal view returns (SplitPolicy memory p) {
        p.treasury = treasury;
        p.taxBps = 2500;
        p.team = new Recipient[](2);
        p.team[0] = Recipient(team1, 1000);
        p.team[1] = Recipient(team2, 500);
    }

    function _pay(uint256 invoiceId) internal view returns (address) {
        return factory.payAddress(DaybookLib.salt(rc, invoiceId));
    }

    function _fund(uint256 invoiceId, uint256 amount) internal {
        usdc.mint(_pay(invoiceId), amount);
    }

    function _settle(uint256 invoiceId, uint256 seq, uint256 amount, uint256 excess) internal {
        vm.prank(proxy);
        till.settle(rc, invoiceId, seq, address(usdc), amount, excess, payer, _policy());
    }

    // ------------------------------------------------------------------ guards

    function test_Settle_RejectsNonProxyCaller() public {
        vm.expectRevert(abi.encodeWithSelector(AbstractPayer.NotAuthorized.selector, address(this), proxy));
        till.settle(rc, 1, 1, address(usdc), 1, 0, payer, _policy());
    }

    function test_Settle_RejectsWrongReactiveSender() public {
        address other = makeAddr("otherRc");
        vm.prank(proxy);
        vm.expectRevert(abi.encodeWithSelector(AbstractCallback.CallbackNotAuthorized.selector, other, rc));
        till.settle(other, 1, 1, address(usdc), 1, 0, payer, _policy());
    }

    function test_Settle_RevertsWhenPaused() public {
        _fund(1, 100e6);
        vm.prank(owner);
        till.pause();
        vm.prank(proxy);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        till.settle(rc, 1, 1, address(usdc), 100e6, 0, payer, _policy());
    }

    function test_Settle_RevertsOverCap() public {
        vm.prank(owner);
        till.setMaxSettlement(IERC20(address(usdc)), 50e6);
        _fund(1, 100e6);
        vm.prank(proxy);
        vm.expectRevert(abi.encodeWithSelector(DaybookTill.CapExceeded.selector, address(usdc), 100e6, 50e6));
        till.settle(rc, 1, 1, address(usdc), 90e6, 10e6, payer, _policy());
    }

    function test_Settle_RevertsForTokenNotEnabled() public {
        MockERC20 other = new MockERC20("X", 6);
        other.mint(_pay(1), 5);
        vm.prank(proxy);
        vm.expectRevert(abi.encodeWithSelector(DaybookTill.CapExceeded.selector, address(other), 5, 0));
        till.settle(rc, 1, 1, address(other), 5, 0, payer, _policy());
    }

    function test_Settle_RevertsOnInvalidPolicy() public {
        _fund(1, 100e6);
        SplitPolicy memory p = _policy();
        p.taxBps = 9000;
        vm.prank(proxy);
        vm.expectRevert(abi.encodeWithSelector(DaybookLib.BpsOverflow.selector, 10_500));
        till.settle(rc, 1, 1, address(usdc), 100e6, 0, payer, p);
    }

    function test_Settle_RevertsWhenPayAddressShort() public {
        _fund(1, 99e6);
        vm.prank(proxy);
        vm.expectRevert();
        till.settle(rc, 1, 1, address(usdc), 100e6, 0, payer, _policy());
        assertFalse(till.settled(1, 1), "a failed settle leaves no mark, so the resend can succeed");
    }

    // ------------------------------------------------------------- happy path

    function test_Settle_SplitsAndEmitsAck() public {
        _fund(7, 1000e6);
        vm.expectEmit(true, true, true, true, address(till));
        emit IDaybookTill.Settled(7, 3, address(usdc), 1000e6, 0, payer, block.chainid, bytes32(0));
        _settle(7, 3, 1000e6, 0);
        assertEq(usdc.balanceOf(address(reserve)), 250e6);
        assertEq(usdc.balanceOf(team1), 100e6);
        assertEq(usdc.balanceOf(team2), 50e6);
        assertEq(usdc.balanceOf(treasury), 600e6);
        assertEq(usdc.balanceOf(_pay(7)), 0);
        assertEq(usdc.balanceOf(address(till)), 0);
        assertTrue(till.settled(7, 3));
        assertEq(reserve.deposited(address(usdc)), 250e6);
    }

    function test_Settle_DeploysVaultOnFirstSweepOnly() public {
        assertEq(_pay(1).code.length, 0, "counterfactual until swept");
        _fund(1, 10e6);
        _settle(1, 1, 10e6, 0);
        assertGt(_pay(1).code.length, 0);
        _fund(1, 5e6);
        _settle(1, 2, 0, 5e6);
        assertEq(usdc.balanceOf(_pay(1)), 0);
    }

    function test_Settle_IdempotentPerSeq() public {
        _fund(1, 200e6);
        _settle(1, 1, 100e6, 0);
        uint256 treasuryBefore = usdc.balanceOf(treasury);
        vm.expectEmit(true, true, false, false, address(till));
        emit DaybookTill.DuplicateSettlement(1, 1);
        _settle(1, 1, 100e6, 0);
        assertEq(usdc.balanceOf(treasury), treasuryBefore);
        assertEq(usdc.balanceOf(_pay(1)), 100e6, "second delivery moved nothing");
    }

    function test_Settle_ExcessOnlyGoesToTreasury() public {
        _fund(1, 33e6);
        _settle(1, 1, 0, 33e6);
        assertEq(usdc.balanceOf(treasury), 33e6);
        assertEq(usdc.balanceOf(team1), 0);
        assertEq(usdc.balanceOf(address(reserve)), 0);
    }

    function test_Settle_ZeroTotalStillAcks() public {
        _settle(1, 1, 0, 0);
        assertTrue(till.settled(1, 1));
    }

    function test_Settle_DustGoesToTreasury() public {
        _fund(1, 7);
        _settle(1, 1, 7, 0);
        // 25% of 7 = 1, 10% = 0, 5% = 0; treasury gets 6.
        assertEq(usdc.balanceOf(address(reserve)), 1);
        assertEq(usdc.balanceOf(treasury), 6);
    }

    // ------------------------------------------------------------- resilience

    function test_Settle_BlockedTeamPayoutRedirectedToTreasury() public {
        usdc.setBlocked(team1, true);
        _fund(1, 1000e6);
        _settle(1, 1, 1000e6, 0);
        assertEq(usdc.balanceOf(team1), 0);
        assertEq(usdc.balanceOf(treasury), 700e6);
    }

    function test_Settle_RevertingReserveRedirectsTax() public {
        RevertingReserve bad = new RevertingReserve();
        vm.prank(owner);
        till.setReserve(bad);
        _fund(1, 1000e6);
        _settle(1, 1, 1000e6, 0);
        assertEq(usdc.balanceOf(treasury), 850e6);
    }

    function test_Settle_NoReserveRedirectsTax() public {
        vm.prank(owner);
        till.setReserve(IReserve(address(0)));
        _fund(1, 1000e6);
        _settle(1, 1, 1000e6, 0);
        assertEq(usdc.balanceOf(treasury), 850e6);
    }

    function test_Settle_ShortPullReserveReverts() public {
        ShortPullReserve bad = new ShortPullReserve();
        vm.prank(owner);
        till.setReserve(bad);
        _fund(1, 1000e6);
        vm.prank(proxy);
        vm.expectRevert(abi.encodeWithSelector(DaybookTill.ReserveMismatch.selector, 125e6, 250e6));
        till.settle(rc, 1, 1, address(usdc), 1000e6, 0, payer, _policy());
    }

    function test_Settle_IssuesEasReceiptToPayer() public {
        MockEAS eas = new MockEAS();
        EasReceiptIssuer issuer = new EasReceiptIssuer(eas, keccak256("schema"), address(till));
        vm.prank(owner);
        till.setReceiptIssuer(issuer);
        _fund(1, 10e6);
        _settle(1, 1, 10e6, 0);
        assertEq(eas.count(), 1);
        assertEq(eas.lastRecipient(), payer);
        (uint256 inv, uint256 seq, address token, uint256 amount, uint256 chainId) =
            abi.decode(eas.lastData(), (uint256, uint256, address, uint256, uint256));
        assertEq(inv, 1);
        assertEq(seq, 1);
        assertEq(token, address(usdc));
        assertEq(amount, 10e6);
        assertEq(chainId, block.chainid);
    }

    function test_Settle_FailingIssuerDoesNotBlock() public {
        RevertingIssuer issuer = new RevertingIssuer();
        vm.prank(owner);
        till.setReceiptIssuer(issuer);
        _fund(1, 10e6);
        vm.expectEmit(true, true, false, false, address(till));
        emit DaybookTill.ReceiptFailed(1, 1, 0);
        _settle(1, 1, 10e6, 0);
        assertTrue(till.settled(1, 1));
    }

    function test_Settle_GasBurningIssuerIsBounded() public {
        GasBurningIssuer issuer = new GasBurningIssuer();
        vm.prank(owner);
        till.setReceiptIssuer(issuer);
        _fund(1, 10e6);
        vm.prank(proxy);
        uint256 before = gasleft();
        till.settle{ gas: 900_000 }(rc, 1, 1, address(usdc), 10e6, 0, payer, _policy());
        assertLt(before - gasleft(), 900_000);
        assertTrue(till.settled(1, 1));
    }

    // ------------------------------------------------------------------- owner

    function test_Sweep_OwnerMovesWholeBalanceEvenWhenPaused() public {
        _fund(4, 77e6);
        vm.startPrank(owner);
        till.pause();
        vm.expectEmit(true, true, true, true, address(till));
        emit IDaybookTill.ManualSweep(4, address(usdc), treasury, 77e6);
        till.sweep(4, address(usdc), treasury);
        vm.stopPrank();
        assertEq(usdc.balanceOf(treasury), 77e6);
        assertEq(usdc.balanceOf(_pay(4)), 0);
    }

    function test_Sweep_OnlyOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        till.sweep(1, address(usdc), treasury);
    }

    function test_Sweep_RejectsZeroRecipient() public {
        vm.prank(owner);
        vm.expectRevert(DaybookTill.ZeroAddress.selector);
        till.sweep(1, address(usdc), address(0));
    }

    function test_SweepNative_RecoversCoinSentToPayAddress() public {
        vm.deal(_pay(2), 1 ether);
        address payable to = payable(makeAddr("to"));
        vm.prank(owner);
        till.sweepNative(2, to);
        assertEq(to.balance, 1 ether);
    }

    function test_Rescue_And_WithdrawNative() public {
        usdc.mint(address(till), 5);
        vm.deal(address(till), 1 ether);
        vm.startPrank(owner);
        till.rescue(IERC20(address(usdc)), treasury, 5);
        till.withdrawNative(1 ether, payable(treasury));
        vm.stopPrank();
        assertEq(usdc.balanceOf(treasury), 5);
        assertEq(treasury.balance, 1 ether);
    }

    function test_AdminSetters_OnlyOwner() public {
        bytes memory err = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this));
        vm.expectRevert(err);
        till.setReserve(IReserve(address(1)));
        vm.expectRevert(err);
        till.setReceiptIssuer(IReceiptIssuer(address(1)));
        vm.expectRevert(err);
        till.setMaxSettlement(IERC20(address(usdc)), 1);
        vm.expectRevert(err);
        till.pause();
        vm.expectRevert(err);
        till.rescue(IERC20(address(usdc)), treasury, 1);
        vm.expectRevert(err);
        till.withdrawNative(1, payable(treasury));
    }

    function test_Constructor_StoresImmutablesAndAcceptsFunding() public {
        DaybookTill t = new DaybookTill{ value: 0.1 ether }(IPayable(payable(proxy)), rc, factory, owner);
        assertEq(address(t._SERVICE_PROVIDER()), proxy);
        assertEq(t._CALLBACK_SENDER(), rc);
        assertEq(address(t.FACTORY()), address(factory));
        assertEq(address(t).balance, 0.1 ether);
    }

    function test_Constructor_RejectsZeroFactory() public {
        vm.expectRevert(DaybookTill.ZeroAddress.selector);
        new DaybookTill(IPayable(payable(proxy)), rc, PayAddressFactory(address(0)), owner);
    }

    function test_CoverDebt_CallsProvider() public {
        vm.mockCall(proxy, abi.encodeWithSignature("debt(address)", address(till)), abi.encode(uint256(0)));
        till.coverDebt();
    }
}

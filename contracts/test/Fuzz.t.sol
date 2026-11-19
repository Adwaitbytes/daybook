// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { Test } from "forge-std/Test.sol";
import { IPayable } from "@reactive/src/interfaces/IPayable.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { DaybookFixture } from "./harness/DaybookFixture.sol";
import { DaybookReactive } from "../src/DaybookReactive.sol";
import { DaybookTill } from "../src/DaybookTill.sol";
import { PayAddressFactory } from "../src/PayAddressFactory.sol";
import { SavingsVault } from "../src/SavingsVault.sol";
import { DaybookLib, Recipient, SplitPolicy } from "../src/DaybookTypes.sol";
import { MockERC20 } from "./mocks/MockERC20.sol";

/// @notice Exposes the pure matching arithmetic.
contract ReactiveExposed is DaybookReactive {
    constructor(address factory_) DaybookReactive(msg.sender, factory_, CRON100) { }

    function apply_(uint256 remaining, uint256 value, uint8 decimals)
        external
        pure
        returns (uint256, uint256, uint256)
    {
        return _apply(remaining, value, decimals);
    }
}

/// @notice Library-level wrapper so reverts surface as external call reverts.
contract SplitHarness {
    function split(uint256 amount, SplitPolicy memory p)
        external
        pure
        returns (uint256 tax, uint256[] memory team, uint256 treasury)
    {
        return DaybookLib.split(amount, p);
    }
}

contract SplitFuzzTest is Test {
    SplitHarness internal h = new SplitHarness();

    function _policy(uint16 taxBps, uint16[5] memory bps, uint256 n) internal pure returns (SplitPolicy memory p) {
        p.treasury = address(0xA);
        p.taxBps = taxBps;
        p.team = new Recipient[](n);
        for (uint256 i; i < n; ++i) {
            p.team[i] = Recipient(address(uint160(0x100 + i)), bps[i]);
        }
    }

    /// @notice Splits sum exactly to the amount, every share is the floor, and the treasury takes the dust.
    function testFuzz_SplitSumsExactlyAndDustToTreasury(uint256 amount, uint16 taxBps, uint16[5] memory bps, uint8 n)
        public
        view
    {
        amount = bound(amount, 0, type(uint128).max);
        uint256 count = bound(n, 0, 5);
        uint256 budget = 10_000;
        taxBps = uint16(bound(taxBps, 0, budget));
        budget -= taxBps;
        for (uint256 i; i < count; ++i) {
            bps[i] = uint16(bound(bps[i], budget == 0 ? 0 : 1, budget));
            budget -= bps[i];
        }
        SplitPolicy memory p = _policy(taxBps, bps, count);
        (uint256 tax, uint256[] memory team, uint256 treasury) = h.split(amount, p);
        uint256 sum = tax + treasury;
        assertEq(tax, amount * taxBps / 10_000);
        for (uint256 i; i < count; ++i) {
            assertEq(team[i], amount * bps[i] / 10_000);
            sum += team[i];
        }
        assertEq(sum, amount, "splits sum to the amount");
        // The treasury's extra over its own floor share is the dust: less than one unit per rounded share.
        uint256 floorShare = amount * budget / 10_000;
        assertGe(treasury, floorShare);
        assertLe(treasury - floorShare, count + 1);
    }

    function testFuzz_ValidateRejectsOverflow(uint16 taxBps, uint16 teamBps) public {
        vm.assume(uint256(taxBps) + teamBps > 10_000 && teamBps > 0);
        uint16[5] memory bps;
        bps[0] = teamBps;
        SplitPolicy memory p = _policy(taxBps, bps, 1);
        vm.expectRevert(abi.encodeWithSelector(DaybookLib.BpsOverflow.selector, uint256(taxBps) + teamBps));
        this.validateExternal(p);
    }

    function validateExternal(SplitPolicy memory p) external pure {
        DaybookLib.validate(p);
    }
}

contract MatchingFuzzTest is DaybookFixture {
    ReactiveExposed internal exposed;

    function setUp() public override {
        super.setUp();
        exposed = new ReactiveExposed(address(factory));
    }

    /// @notice counted + excess always equals the transfer; credit never exceeds what was outstanding; once the
    /// invoice is covered the counted raw amount is worth at least the remaining amount.
    function testFuzz_ApplyConservesValue(uint256 remaining, uint256 value, uint8 decimals) public view {
        decimals = uint8(bound(decimals, 0, 30));
        remaining = bound(remaining, 1, type(uint128).max);
        value = bound(value, 1, type(uint96).max);
        (uint256 counted, uint256 excess, uint256 credit) = exposed.apply_(remaining, value, decimals);
        assertEq(counted + excess, value);
        assertLe(credit, remaining);
        if (credit == remaining) {
            uint256 worth = decimals >= 6 ? counted / 10 ** (decimals - 6) : counted * 10 ** (6 - decimals);
            assertGe(worth, remaining);
        } else {
            assertEq(excess, 0);
        }
    }

    /// @notice Any sequence of partial payments on two chains: `paid` is the capped sum, the ledger matches the
    /// transfers one for one, and the invoice settles exactly when (and only when) it is covered, with every
    /// unit that arrived paid out and nothing left in the pay address.
    function testFuzz_PartialPaymentsAcrossChains(uint256 amount, uint256[6] memory parts, uint256 chainMask) public {
        amount = bound(amount, 1e6, 10_000e6);
        uint256 id = _createAB(amount);
        address pay = reactive.payAddressOf(id);
        uint256 sentA;
        uint256 sentB;
        uint256 total;
        uint256 entries;
        for (uint256 i; i < parts.length; ++i) {
            uint256 v = bound(parts[i], 1, amount / 2 + 1);
            bool onA = (chainMask >> i) & 1 == 0;
            bool open = reactive.getInvoice(id).status == DaybookReactive.InvoiceStatus.Open;
            if (!open) break; // after cover the subscription is gone; later transfers are not delivered
            _payInvoice(onA ? CHAIN_A : CHAIN_B, id, v);
            if (onA) sentA += v;
            else sentB += v;
            total += v;
            ++entries;
        }
        DaybookReactive.Invoice memory inv = reactive.getInvoice(id);
        assertEq(inv.paid, total < amount ? total : amount);
        assertEq(reactive.ledgerLength(), entries);
        uint256 ledgerSum;
        for (uint256 i; i < entries; ++i) {
            ledgerSum += reactive.ledgerEntry(i).amount;
        }
        assertEq(ledgerSum, total, "ledger total equals matched transfers");
        if (total >= amount) {
            assertEq(uint8(inv.status), uint8(DaybookReactive.InvoiceStatus.Settled));
            assertEq(usd[CHAIN_A].balanceOf(pay) + usd[CHAIN_B].balanceOf(pay), 0, "nothing left behind");
            assertEq(_paidOut(CHAIN_A), sentA);
            assertEq(_paidOut(CHAIN_B), sentB);
        } else {
            assertEq(uint8(inv.status), uint8(DaybookReactive.InvoiceStatus.Open));
            assertEq(usd[CHAIN_A].balanceOf(pay), sentA);
            assertEq(usd[CHAIN_B].balanceOf(pay), sentB);
        }
    }

    /// @notice Replaying any delivered transfer any number of times never changes the books.
    function testFuzz_DuplicateDeliveriesIgnored(uint256 v, uint8 replays) public {
        uint256 id = _createAB(1000e6);
        v = bound(v, 1, 999e6);
        _payInvoice(CHAIN_A, id, v);
        uint256 rec = _historyLength() - 1;
        replays = uint8(bound(replays, 1, 10));
        for (uint256 i; i < replays; ++i) {
            _replay(rec);
        }
        assertEq(reactive.getInvoice(id).paid, v);
        assertEq(reactive.ledgerLength(), 1);
    }

    /// @notice Overpayment of any size: the split is on the invoice amount, the excess goes to the treasury.
    function testFuzz_OverpaymentExcessExact(uint256 amount, uint256 extra) public {
        // Kept within the till's per-settlement cap; above it the till refuses by design (tested separately).
        amount = bound(amount, 1, CAP / 2);
        extra = bound(extra, 0, CAP / 2);
        uint256 id = _createAB(amount);
        _payInvoice(CHAIN_B, id, amount + extra);
        uint256 tax = amount * TAX_BPS / 10_000;
        uint256 t1 = amount * TEAM1_BPS / 10_000;
        uint256 t2 = amount * TEAM2_BPS / 10_000;
        assertEq(usd[CHAIN_B].balanceOf(treasury), amount - tax - t1 - t2 + extra);
        assertEq(_paidOut(CHAIN_B), amount + extra);
    }
}

contract TillFuzzTest is Test {
    address internal proxy = makeAddr("proxy");
    address internal rc = makeAddr("rc");
    address internal owner = makeAddr("owner");
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
        till.setMaxSettlement(IERC20(address(usdc)), type(uint256).max);
        vm.stopPrank();
    }

    /// @notice Whatever the policy and amounts, every unit swept leaves the till to exactly one destination.
    function testFuzz_SettleConservesFunds(uint128 amount, uint128 excess, uint16 taxBps, uint16[5] memory bps, uint8 n)
        public
    {
        uint256 count = bound(n, 0, 5);
        uint256 budget = 10_000;
        taxBps = uint16(bound(taxBps, 0, budget));
        budget -= taxBps;
        SplitPolicy memory p;
        p.treasury = makeAddr("treasury");
        p.taxBps = taxBps;
        p.team = new Recipient[](count);
        for (uint256 i; i < count; ++i) {
            uint16 b = uint16(bound(bps[i], budget == 0 ? 0 : 1, budget));
            if (b == 0) {
                count = i;
                assembly ("memory-safe") {
                    mstore(mload(add(p, 0x40)), i)
                }
                break;
            }
            budget -= b;
            p.team[i] = Recipient(address(uint160(0x1000 + i)), b);
        }
        address pay = factory.payAddress(DaybookLib.salt(rc, 1));
        usdc.mint(pay, uint256(amount) + excess);
        vm.prank(proxy);
        till.settle(rc, 1, 1, address(usdc), amount, excess, address(this), p);
        uint256 out = usdc.balanceOf(p.treasury) + usdc.balanceOf(address(reserve));
        for (uint256 i; i < p.team.length; ++i) {
            out += usdc.balanceOf(p.team[i].account);
        }
        assertEq(out, uint256(amount) + excess);
        assertEq(usdc.balanceOf(pay), 0);
        assertEq(usdc.balanceOf(address(till)), 0);
    }
}

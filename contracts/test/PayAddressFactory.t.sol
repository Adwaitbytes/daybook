// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { Test } from "forge-std/Test.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { InvoiceVault, PayAddressFactory } from "../src/PayAddressFactory.sol";
import { DaybookReactive } from "../src/DaybookReactive.sol";
import { SavingsVault } from "../src/SavingsVault.sol";
import { EasReceiptIssuer, IEAS } from "../src/EasReceiptIssuer.sol";
import { DaybookLib } from "../src/DaybookTypes.sol";
import { MockERC20 } from "./mocks/MockERC20.sol";
import { MockEAS } from "./mocks/Mocks.sol";

contract PayAddressFactoryTest is Test {
    /// @dev Foundry routes `new X{salt: s}` in scripts through this canonical deployer; tests etch it.
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    uint256 internal constant CRON100 = 0xb49937fb8970e19fd46d48f7e3fb00d659deac0347f79cd7cb542f0fc1503c70;

    address internal owner = makeAddr("owner");
    address internal till = makeAddr("till");
    PayAddressFactory internal factory;
    MockERC20 internal usdc;

    function setUp() public {
        factory = new PayAddressFactory(owner);
        usdc = new MockERC20("USDC", 6);
        vm.prank(owner);
        factory.setTill(till, true);
    }

    function test_PayAddress_IsCounterfactualAndStable() public {
        bytes32 salt = keccak256("x");
        address predicted = factory.payAddress(salt);
        assertEq(predicted.code.length, 0);
        assertEq(factory.deploy(salt), predicted);
        assertGt(predicted.code.length, 0);
        assertEq(factory.deploy(salt), predicted, "deploy is idempotent");
    }

    function test_Sweep_OnlyTill() public {
        vm.expectRevert(abi.encodeWithSelector(PayAddressFactory.NotTill.selector, address(this)));
        factory.sweep(bytes32(0), IERC20(address(usdc)), 1);
    }

    function test_Sweep_SendsToCallingTillOnly() public {
        bytes32 salt = keccak256("y");
        usdc.mint(factory.payAddress(salt), 10);
        vm.prank(till);
        factory.sweep(salt, IERC20(address(usdc)), 10);
        assertEq(usdc.balanceOf(till), 10);
    }

    function test_Vault_OnlyFactoryCanMoveFunds() public {
        bytes32 salt = keccak256("z");
        address vault = factory.deploy(salt);
        usdc.mint(vault, 10);
        vm.expectRevert(InvoiceVault.OnlyFactory.selector);
        InvoiceVault(payable(vault)).sweep(IERC20(address(usdc)), address(this), 10);
        vm.expectRevert(InvoiceVault.OnlyFactory.selector);
        InvoiceVault(payable(vault)).sweepNative(payable(address(this)));
    }

    function test_SetTill_OwnerOnlyAndRevocable() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        factory.setTill(address(this), true);
        vm.startPrank(owner);
        vm.expectRevert(PayAddressFactory.ZeroAddress.selector);
        factory.setTill(address(0), true);
        factory.setTill(till, false);
        vm.stopPrank();
        assertFalse(factory.isTill(till));
        vm.prank(till);
        vm.expectRevert(abi.encodeWithSelector(PayAddressFactory.NotTill.selector, till));
        factory.sweep(bytes32(0), IERC20(address(usdc)), 0);
    }

    function test_SweepNative_RejectsZeroRecipient() public {
        vm.prank(till);
        vm.expectRevert(PayAddressFactory.ZeroAddress.selector);
        factory.sweepNative(bytes32(0), payable(address(0)));
    }

    /// @notice The property everything rests on: deployed through the CREATE2 deployer with the same salt and
    /// init code, the factory and every pay address land at the same address whatever the chain id.
    function test_Deterministic_SameAddressesOnEveryChain() public {
        vm.etch(
            CREATE2_DEPLOYER,
            hex"7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3"
        );
        bytes memory init = abi.encodePacked(type(PayAddressFactory).creationCode, abi.encode(owner));
        bytes32 salt = keccak256("daybook.factory.v1");
        uint256[4] memory chains = [uint256(84_532), 1301, 8453, 42_161];
        address firstFactory;
        address firstPay;
        uint256 snap = vm.snapshotState();
        for (uint256 i; i < chains.length; ++i) {
            vm.revertToState(snap);
            vm.chainId(chains[i]);
            (bool ok, bytes memory ret) = CREATE2_DEPLOYER.call(abi.encodePacked(salt, init));
            assertTrue(ok);
            address f = address(bytes20(ret));
            address pay = PayAddressFactory(f).payAddress(DaybookLib.salt(address(0xBEEF), 42));
            if (i == 0) {
                firstFactory = f;
                firstPay = pay;
            }
            assertEq(f, firstFactory, "factory address differs across chains");
            assertEq(pay, firstPay, "pay address differs across chains");
            assertEq(f, vm.computeCreate2Address(salt, keccak256(init), CREATE2_DEPLOYER));
        }
    }

    function testFuzz_ReactiveComputesSamePayAddressAsFactory(uint256 invoiceId) public {
        DaybookReactive r = new DaybookReactive(owner, address(factory), CRON100);
        assertEq(r.payAddressOf(invoiceId), factory.payAddress(DaybookLib.salt(address(r), invoiceId)));
    }

    function testFuzz_DistinctSaltsGiveDistinctAddresses(bytes32 a, bytes32 b) public view {
        vm.assume(a != b);
        assertTrue(factory.payAddress(a) != factory.payAddress(b));
    }

    // -------------------------------------------------------- vault and issuer

    function test_SavingsVault_DepositAndOwnerWithdraw() public {
        SavingsVault v = new SavingsVault(owner);
        usdc.mint(address(this), 100);
        usdc.approve(address(v), 100);
        v.deposit(address(usdc), 100, 9);
        assertEq(v.deposited(address(usdc)), 100);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        v.withdraw(address(usdc), address(this), 1);
        vm.prank(owner);
        v.withdraw(address(usdc), owner, 60);
        assertEq(usdc.balanceOf(owner), 60);
        vm.prank(owner);
        vm.expectRevert(SavingsVault.ZeroAddress.selector);
        v.withdraw(address(usdc), address(0), 1);
    }

    function test_EasIssuer_OnlyTillAndNoZeroArgs() public {
        MockEAS eas = new MockEAS();
        EasReceiptIssuer issuer = new EasReceiptIssuer(eas, bytes32("s"), till);
        vm.expectRevert(EasReceiptIssuer.OnlyTill.selector);
        issuer.issue(1, 1, address(1), address(usdc), 1);
        vm.prank(till);
        assertTrue(issuer.issue(1, 1, address(1), address(usdc), 1) != bytes32(0));
        vm.expectRevert(EasReceiptIssuer.ZeroAddress.selector);
        new EasReceiptIssuer(IEAS(address(0)), bytes32("s"), till);
        vm.expectRevert(EasReceiptIssuer.ZeroAddress.selector);
        new EasReceiptIssuer(eas, bytes32("s"), address(0));
    }
}

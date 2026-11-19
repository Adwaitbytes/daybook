// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IReserve } from "../../src/interfaces/IReserve.sol";
import { IReceiptIssuer } from "../../src/interfaces/IReceiptIssuer.sol";
import { IEAS } from "../../src/EasReceiptIssuer.sol";

contract RevertingReserve is IReserve {
    function deposit(address, uint256, uint256) external pure {
        revert("reserve down");
    }
}

/// @notice Pulls only half of what it is asked to: a broken integration the till must refuse.
contract ShortPullReserve is IReserve {
    function deposit(address token, uint256 amount, uint256) external {
        IERC20(token).transferFrom(msg.sender, address(this), amount / 2);
    }
}

contract RevertingIssuer is IReceiptIssuer {
    function issue(uint256, uint256, address, address, uint256) external pure returns (bytes32) {
        revert("issuer down");
    }
}

contract GasBurningIssuer is IReceiptIssuer {
    function issue(uint256, uint256, address, address, uint256) external view returns (bytes32) {
        while (gasleft() > 1000) { }
        return bytes32(0);
    }
}

contract MockEAS is IEAS {
    uint256 public count;
    AttestationRequest internal _last;

    function attest(AttestationRequest calldata request) external payable returns (bytes32 uid) {
        ++count;
        _last = request;
        uid = keccak256(abi.encode(count, request.schema, request.data.recipient));
    }

    function lastRecipient() external view returns (address) {
        return _last.data.recipient;
    }

    function lastData() external view returns (bytes memory) {
        return _last.data.data;
    }
}

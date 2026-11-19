// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { ISystemContract } from "@reactive/src/interfaces/ISystemContract.sol";

/// @notice Local stand-in for the Reactive system contract, etched at 0x8888...8888 in tests.
/// It keeps one storage bit per active subscription (so unsubscribe is exact-match and fails silently, as on
/// the node) and reports everything else as events, which the harness reads back to build its subscription
/// table and callback queue. Keeping the bookkeeping out of storage keeps the gas a reactive contract spends
/// here close to what the real system contract costs, so the harness's 900k reactive gas cap is meaningful.
/// It does not model fees, debt, latency or ordering.
contract MockSystemContract {
    uint64 internal constant MIN_CALLBACK_GAS = 100_000;

    mapping(bytes32 key => bool) internal _active;

    event Subscribed(
        address indexed rc, uint256 chainId, address contractAddr, uint256 t0, uint256 t1, uint256 t2, uint256 t3
    );
    event Unsubscribed(
        address indexed rc, uint256 chainId, address contractAddr, uint256 t0, uint256 t1, uint256 t2, uint256 t3
    );
    event UnsubscribeMiss(address indexed rc);
    event CallbackRequested(address indexed rc, uint256 chainId, address recipient, uint64 gasLimit, bytes payload);
    event CallbackIgnored(address indexed rc, uint64 gasLimit);

    function subscribe(uint256 chainId, address c, uint256 t0, uint256 t1, uint256 t2, uint256 t3) external {
        bytes32 key = keccak256(abi.encode(msg.sender, chainId, c, t0, t1, t2, t3));
        if (_active[key]) return; // duplicates behave as one
        _active[key] = true;
        emit Subscribed(msg.sender, chainId, c, t0, t1, t2, t3);
    }

    function unsubscribe(uint256 chainId, address c, uint256 t0, uint256 t1, uint256 t2, uint256 t3) external {
        bytes32 key = keccak256(abi.encode(msg.sender, chainId, c, t0, t1, t2, t3));
        if (!_active[key]) {
            emit UnsubscribeMiss(msg.sender);
            return;
        }
        delete _active[key];
        emit Unsubscribed(msg.sender, chainId, c, t0, t1, t2, t3);
    }

    function requestCallbackV_1_0(ISystemContract.CallbackConfiguration_V_1_0 memory config) external {
        _request(config);
    }

    function requestCallback(ISystemContract.CallbackVersion, bytes memory config) external {
        _request(abi.decode(config, (ISystemContract.CallbackConfiguration_V_1_0)));
    }

    function _request(ISystemContract.CallbackConfiguration_V_1_0 memory config) internal {
        if (config.gasLimit < MIN_CALLBACK_GAS) {
            emit CallbackIgnored(msg.sender, config.gasLimit);
            return;
        }
        emit CallbackRequested(msg.sender, config.chainId, config.recipient, config.gasLimit, config.payload);
    }

    function isActive(address rc, uint256 chainId, address c, uint256 t0, uint256 t1, uint256 t2, uint256 t3)
        external
        view
        returns (bool)
    {
        return _active[keccak256(abi.encode(rc, chainId, c, t0, t1, t2, t3))];
    }

    function debt(address) external pure returns (uint256) {
        return 0;
    }

    function depositTo(address) external payable { }

    receive() external payable { }
}

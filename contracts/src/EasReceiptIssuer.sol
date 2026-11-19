// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { IReceiptIssuer } from "./interfaces/IReceiptIssuer.sol";

/// @notice The subset of the Ethereum Attestation Service interface this issuer uses.
interface IEAS {
    struct AttestationRequestData {
        address recipient;
        uint64 expirationTime;
        bool revocable;
        bytes32 refUID;
        bytes data;
        uint256 value;
    }

    struct AttestationRequest {
        bytes32 schema;
        AttestationRequestData data;
    }

    function attest(AttestationRequest calldata request) external payable returns (bytes32);
}

/// @title EasReceiptIssuer
/// @notice Issues a payment receipt as an EAS attestation to the payer. Used only on chains where EAS is
/// deployed and its address has been verified; elsewhere the till runs with no issuer and its `Receipt` event
/// is the receipt.
/// @dev Schema: "uint256 invoiceId,uint256 seq,address token,uint256 amount,uint256 chainId". The attester is
/// this contract, so a verifier checks attestations against this address and the schema UID.
contract EasReceiptIssuer is IReceiptIssuer {
    IEAS public immutable EAS;
    bytes32 public immutable SCHEMA;
    address public immutable TILL;

    error OnlyTill();
    error ZeroAddress();

    constructor(IEAS eas_, bytes32 schema_, address till_) {
        if (address(eas_) == address(0) || till_ == address(0)) revert ZeroAddress();
        EAS = eas_;
        SCHEMA = schema_;
        TILL = till_;
    }

    /// @inheritdoc IReceiptIssuer
    function issue(uint256 invoiceId, uint256 seq, address payer, address token, uint256 amount)
        external
        returns (bytes32 uid)
    {
        if (msg.sender != TILL) revert OnlyTill();
        uid = EAS.attest(
            IEAS.AttestationRequest({
                schema: SCHEMA,
                data: IEAS.AttestationRequestData({
                    recipient: payer,
                    expirationTime: 0,
                    revocable: false,
                    refUID: bytes32(0),
                    data: abi.encode(invoiceId, seq, token, amount, block.chainid),
                    value: 0
                })
            })
        );
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../interfaces/IPorter.sol";

/// @title MockLocationVerifier
/// @notice Test double for IPorterLocationVerifier. Lets the PorterSettlement
///         integration tests exercise the confirmDropoffZK path (attestation
///         binding, commitment binding, nullifier replay guard, status gates)
///         without running the real Groth16 trusted setup — the cryptographic
///         soundness of the circuit is covered separately by the snarkjs
///         fixture tests once `setup-zk` has produced proving artifacts.
///
///         `result` is the answer verifyProximity returns; `lastProof` /
///         `lastPubSignals` record the last call for assertions.
contract MockLocationVerifier is IPorterLocationVerifier {
    bool public result = true;
    bytes public lastProof;
    uint256[5] public lastPubSignals;

    function setResult(bool _result) external {
        result = _result;
    }

    function verifyProximity(bytes calldata, uint256[5] calldata)
        external
        view
        override
        returns (bool)
    {
        return result;
    }

    /// @notice Non-view recorder for tests that want to assert on the exact
    ///         signals the settlement contract forwarded.
    function recordAndVerify(bytes calldata proof, uint256[5] calldata pubSignals)
        external
        returns (bool)
    {
        lastProof = proof;
        lastPubSignals = pubSignals;
        return result;
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Test double for the personhood adapter: a settable set of people.
contract MockPersonhood {
    mapping(address => bool) public isPerson;

    function set(address account, bool person) external {
        isPerson[account] = person;
    }
}

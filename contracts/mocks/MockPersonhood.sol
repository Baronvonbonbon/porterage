// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.24;

/// Test double for the personhood adapter: a settable set of people.
contract MockPersonhood {
    mapping(address => bool) public isPerson;

    function set(address account, bool person) external {
        isPerson[account] = person;
    }
}

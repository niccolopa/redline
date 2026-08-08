// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract RedlineVault {
    address public immutable oracle;
    int256 public immutable redlineThreshold;

    enum Mode { CALM, REDLINED }
    Mode public currentMode;

    int256 public latestScore;
    uint256 public lastUpdateTimestamp;

    uint256 public vaultBalance;
    uint256 public bunkerBalance;

    mapping(address => uint256) public userBalances;

    event Deposited(address indexed user, uint256 amount);
    event ScoreUpdated(int256 score, uint256 timestamp);
    event Redlined(uint256 timestamp, uint256 amountSheltered, address indexed triggeredBy);

    modifier onlyOracle() {
        require(msg.sender == oracle, "UNAUTHORIZED: Not oracle");
        _;
    }

    constructor(int256 _redlineThreshold) {
        oracle = msg.sender;
        redlineThreshold = _redlineThreshold;
        currentMode = Mode.CALM;
    }

    /// @dev Called continuously. Kept minimal to minimize gas usage on Monad.
    function postScore(int256 _score0to100) external onlyOracle {
        latestScore = _score0to100;
        lastUpdateTimestamp = block.timestamp;
        emit ScoreUpdated(_score0to100, lastUpdateTimestamp);
    }

    function deposit() external payable {
        require(currentMode == Mode.CALM, "BLOCKED: Vault is redlined");
        require(msg.value > 0, "INVALID: Zero deposit");

        userBalances[msg.sender] += msg.value;
        vaultBalance += msg.value;

        emit Deposited(msg.sender, msg.value);
    }

    /// @dev Public alarm trigger. Succeeds only if the deterministic score permits it.
    function redline() external {
        require(currentMode == Mode.CALM, "REVERT: Already redlined");
        require(latestScore >= redlineThreshold, "REVERT: Score below threshold");

        // Execute safety migration
        bunkerBalance = vaultBalance;
        vaultBalance = 0;
        currentMode = Mode.REDLINED;

        emit Redlined(block.timestamp, bunkerBalance, msg.sender);
    }

    function withdraw() external {
        uint256 amount = userBalances[msg.sender];
        require(amount > 0, "REVERT: No balance");

        // Checks-Effects-Interactions: Update state before transfer
        userBalances[msg.sender] = 0;

        if (currentMode == Mode.CALM) {
            vaultBalance -= amount;
        } else {
            bunkerBalance -= amount;
        }

        (bool success, ) = payable(msg.sender).call{value: amount}("");
        require(success, "REVERT: Transfer failed");
    }

    /// @dev Admin fallback for demo resets or emergencies.
    function setMode(uint8 _mode) external onlyOracle {
        require(_mode <= 1, "INVALID: Mode out of bounds");
        currentMode = Mode(_mode);
    }
}
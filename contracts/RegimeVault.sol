// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title RegimeVault — a Hidden Markov Model forward filter that runs on-chain.
///
/// The oracle does NOT post a verdict. It posts what happened — one log return
/// per bar — and this contract runs the Bayesian recursion itself. The regime
/// posterior is computed by the chain, not asserted by a trusted party.
///
/// The HMM splits along its own math:
///   training  (Baum-Welch/EM) — expensive, non-deterministic → off-chain, once,
///             results pinned here as immutables (see engine/fit_hmm.py)
///   inference (forward filter) — O(K^2) per bar, exactly deterministic → here
///
/// Two independent methods must agree before funds move: the deterministic
/// Redline Score (rolling windows, posted by the oracle) AND the HMM posterior
/// (computed here). Measured over 44,640 bars of ETH/USDT, requiring both cuts
/// breach bars from 383 to 131 versus the score alone.
contract RegimeVault {
    // ---------------------------------------------------------------- fixed point
    int256 private constant WAD = 1e18;
    int256 private constant LOG2_E = 1_442695040888963407;
    int256 private constant D_CLAMP = 40e18; // p saturates far below this

    // ---------------------------------------------------------------- HMM params
    // Fitted off-chain on bars strictly before the demo window. Immutable: the
    // model cannot be swapped after deployment, so the filter is auditable.
    int256 public immutable MU_CALM;         // mean log return, calm state
    int256 public immutable MU_TURB;         // mean log return, turbulent state
    int256 public immutable INV_CALM;        // 1 / (2 * sigma_calm^2)
    int256 public immutable INV_TURB;        // 1 / (2 * sigma_turb^2)
    int256 public immutable LN_SIGMA_RATIO;  // ln(sigma_calm / sigma_turb), negative
    int256 public immutable A01;             // P(calm -> turbulent)
    int256 public immutable A11;             // P(turbulent -> turbulent)
    int256 public immutable P0;              // stationary prior, the belief to rewind to

    // ---------------------------------------------------------------- thresholds
    int256 public immutable redlineThreshold; // deterministic score, 0..100
    int256 public immutable regimeThreshold;  // HMM posterior, WAD (0.8e18 = 80%)
    address public immutable oracle;

    // ---------------------------------------------------------------- state
    enum Mode { CALM, REDLINED }
    Mode public currentMode;

    int256 public regimeProb;          // P(turbulent | all bars so far), WAD
    int256 public latestScore;         // deterministic Redline Score, 0..100
    uint256 public lastUpdateTimestamp;
    uint256 public barsProcessed;

    uint256 public vaultBalance;
    uint256 public bunkerBalance;
    mapping(address => uint256) public userBalances;

    event Deposited(address indexed user, uint256 amount);
    event ScoreUpdated(int256 score, uint256 timestamp);
    event RegimeUpdated(int256 logReturn, int256 regimeProb, uint256 timestamp);
    event Redlined(uint256 timestamp, uint256 amountSheltered, address indexed triggeredBy);

    modifier onlyOracle() {
        require(msg.sender == oracle, "UNAUTHORIZED: Not oracle");
        _;
    }

    constructor(
        int256 _redlineThreshold,
        int256 _regimeThreshold,
        int256[8] memory hmm // MU_CALM, MU_TURB, INV_CALM, INV_TURB, LN_RATIO, A01, A11, P0
    ) {
        oracle = msg.sender;
        redlineThreshold = _redlineThreshold;
        regimeThreshold = _regimeThreshold;

        MU_CALM = hmm[0];
        MU_TURB = hmm[1];
        INV_CALM = hmm[2];
        INV_TURB = hmm[3];
        LN_SIGMA_RATIO = hmm[4];
        A01 = hmm[5];
        A11 = hmm[6];
        P0 = hmm[7];
        regimeProb = hmm[7]; // stationary prior

        // Interior transitions keep p strictly inside (0,1) forever: the filter
        // can never lock at certainty, and the update denominator is never zero.
        require(hmm[5] > 0 && hmm[5] < WAD, "A01 must be interior");
        require(hmm[6] > 0 && hmm[6] < WAD, "A11 must be interior");

        currentMode = Mode.CALM;
    }

    // ---------------------------------------------------------------- the filter

    /// @notice One bar of the HMM forward recursion. Pure — the test surface.
    /// @param p Prior P(turbulent), WAD. @param r Log return of the bar, WAD.
    function previewStep(int256 p, int256 r) public view returns (int256) {
        // predict: mix the belief through the transition matrix (linear, exact)
        int256 pPred = A01 + _mulWad(p, A11 - A01);

        // log-likelihood ratio of turbulent vs calm.
        // d = ln(s_calm/s_turb) + (r-mu_calm)^2/(2 s_calm^2) - (r-mu_turb)^2/(2 s_turb^2)
        // The 1/sqrt(2*pi) is common to both states and cancels in the ratio.
        int256 dr0 = r - MU_CALM;
        int256 dr1 = r - MU_TURB;
        int256 d = LN_SIGMA_RATIO
            + _mulWad(_mulWad(dr0, dr0), INV_CALM)
            - _mulWad(_mulWad(dr1, dr1), INV_TURB);
        if (d > D_CLAMP) d = D_CLAMP;
        if (d < -D_CLAMP) d = -D_CLAMP;

        // update: Bayes, divided through by the calm likelihood so only e^d is needed
        int256 numer = _mulWad(pPred, _expWad(d));
        return (numer * WAD) / (numer + WAD - pPred);
    }

    /// @notice One bar: the attested deterministic score plus the raw observation.
    /// Single transaction so `eth_sendRawTransactionSync` returns both in one receipt.
    function tick(int256 score0to100, int256 logReturnWad) external onlyOracle {
        latestScore = score0to100;
        regimeProb = previewStep(regimeProb, logReturnWad);
        lastUpdateTimestamp = block.timestamp;
        barsProcessed++;

        emit ScoreUpdated(score0to100, block.timestamp);
        emit RegimeUpdated(logReturnWad, regimeProb, block.timestamp);
    }

    // ---------------------------------------------------------------- vault

    function deposit() external payable {
        require(currentMode == Mode.CALM, "BLOCKED: Vault is redlined");
        require(msg.value > 0, "INVALID: Zero deposit");
        userBalances[msg.sender] += msg.value;
        vaultBalance += msg.value;
        emit Deposited(msg.sender, msg.value);
    }

    /// @notice Anyone may pull the alarm. It only rings when BOTH independent
    /// methods agree — one deterministic, one probabilistic, both on-chain.
    function redline() external {
        require(currentMode == Mode.CALM, "REVERT: Already redlined");
        require(latestScore >= redlineThreshold, "REVERT: Score below threshold");
        require(regimeProb >= regimeThreshold, "REVERT: Regime not turbulent");
        // A stale score must not authorise a redline hours after the fact.
        require(block.timestamp - lastUpdateTimestamp <= 120, "REVERT: Data stale");

        uint256 sheltered = vaultBalance;
        bunkerBalance += sheltered;   // accumulate: a second cycle must not erase the first
        vaultBalance = 0;
        currentMode = Mode.REDLINED;
        emit Redlined(block.timestamp, sheltered, msg.sender);
    }

    /// @notice A depositor can always take their money out, in any mode.
    /// @dev userBalances is the record of custody; vaultBalance and bunkerBalance
    /// only report WHERE it sits. Draining the bunker first keeps the invariant
    /// vaultBalance + bunkerBalance == sum(userBalances) whatever the ordering of
    /// redline / reset / deposit — picking a bucket by CURRENT mode does not, and
    /// stranded funds behind an underflow after a reset.
    function withdraw() external {
        uint256 amount = userBalances[msg.sender];
        require(amount > 0, "REVERT: No balance");
        userBalances[msg.sender] = 0;

        uint256 fromBunker = amount > bunkerBalance ? bunkerBalance : amount;
        bunkerBalance -= fromBunker;
        vaultBalance -= (amount - fromBunker);

        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        require(ok, "REVERT: Transfer failed");
    }

    /// @dev Demo reset. Rewinds the belief to the stationary prior as well as the
    /// mode — the filter is a recursion, so replaying a run against a belief left
    /// over from the previous one produces a state no reference model can match.
    function setMode(uint8 _mode) external onlyOracle {
        require(_mode <= 1, "INVALID: Mode out of bounds");
        currentMode = Mode(_mode);
        regimeProb = P0;
        latestScore = 0;
        barsProcessed = 0;
    }

    // ---------------------------------------------------------------- math
    // exp2 below is PRBMath (MIT, github.com/PaulRBerg/prb-math), vendored
    // verbatim rather than reimplemented. Fixed-point exp is a bug farm.

    function _mulWad(int256 a, int256 b) private pure returns (int256) {
        return (a * b) / WAD;
    }

    function _expWad(int256 x) private pure returns (int256) {
        return _exp2Wad((x * LOG2_E) / WAD);
    }

    function _exp2Wad(int256 x) private pure returns (int256) {
        if (x < 0) {
            if (x < -59_794705707972522261) return 0;
            unchecked { return 1e36 / _exp2Wad(-x); }
        }
        unchecked {
            return int256(_exp2((uint256(x) << 64) / uint256(WAD)));
        }
    }

    /// @dev PRBMath.exp2: input in 192.64-bit fixed point, output in 60.18.
    function _exp2(uint256 x) private pure returns (uint256 result) {
        unchecked {
            result = 0x800000000000000000000000000000000000000000000000;
            if (x & 0x8000000000000000 > 0) result = (result * 0x16A09E667F3BCC909) >> 64;
            if (x & 0x4000000000000000 > 0) result = (result * 0x1306FE0A31B7152DF) >> 64;
            if (x & 0x2000000000000000 > 0) result = (result * 0x1172B83C7D517ADCE) >> 64;
            if (x & 0x1000000000000000 > 0) result = (result * 0x10B5586CF9890F62A) >> 64;
            if (x & 0x800000000000000 > 0) result = (result * 0x1059B0D31585743AE) >> 64;
            if (x & 0x400000000000000 > 0) result = (result * 0x102C9A3E778060EE7) >> 64;
            if (x & 0x200000000000000 > 0) result = (result * 0x10163DA9FB33356D8) >> 64;
            if (x & 0x100000000000000 > 0) result = (result * 0x100B1AFA5ABCBED61) >> 64;
            if (x & 0x80000000000000 > 0) result = (result * 0x10058C86DA1C09EA2) >> 64;
            if (x & 0x40000000000000 > 0) result = (result * 0x1002C605E2E8CEC50) >> 64;
            if (x & 0x20000000000000 > 0) result = (result * 0x100162F3904051FA1) >> 64;
            if (x & 0x10000000000000 > 0) result = (result * 0x1000B175EFFDC76BA) >> 64;
            if (x & 0x8000000000000 > 0) result = (result * 0x100058BA01FB9F96D) >> 64;
            if (x & 0x4000000000000 > 0) result = (result * 0x10002C5CC37DA9492) >> 64;
            if (x & 0x2000000000000 > 0) result = (result * 0x1000162E525EE0547) >> 64;
            if (x & 0x1000000000000 > 0) result = (result * 0x10000B17255775C04) >> 64;
            if (x & 0x800000000000 > 0) result = (result * 0x1000058B91B5BC9AE) >> 64;
            if (x & 0x400000000000 > 0) result = (result * 0x100002C5C89D5EC6D) >> 64;
            if (x & 0x200000000000 > 0) result = (result * 0x10000162E43F4F831) >> 64;
            if (x & 0x100000000000 > 0) result = (result * 0x100000B1721BCFC9A) >> 64;
            if (x & 0x80000000000 > 0) result = (result * 0x10000058B90CF1E6E) >> 64;
            if (x & 0x40000000000 > 0) result = (result * 0x1000002C5C863B73F) >> 64;
            if (x & 0x20000000000 > 0) result = (result * 0x100000162E430E5A2) >> 64;
            if (x & 0x10000000000 > 0) result = (result * 0x1000000B172183551) >> 64;
            if (x & 0x8000000000 > 0) result = (result * 0x100000058B90C0B49) >> 64;
            if (x & 0x4000000000 > 0) result = (result * 0x10000002C5C8601CC) >> 64;
            if (x & 0x2000000000 > 0) result = (result * 0x1000000162E42FFF0) >> 64;
            if (x & 0x1000000000 > 0) result = (result * 0x10000000B17217FBB) >> 64;
            if (x & 0x800000000 > 0) result = (result * 0x1000000058B90BFCE) >> 64;
            if (x & 0x400000000 > 0) result = (result * 0x100000002C5C85FE3) >> 64;
            if (x & 0x200000000 > 0) result = (result * 0x10000000162E42FF1) >> 64;
            if (x & 0x100000000 > 0) result = (result * 0x100000000B17217F8) >> 64;
            if (x & 0x80000000 > 0) result = (result * 0x10000000058B90BFC) >> 64;
            if (x & 0x40000000 > 0) result = (result * 0x1000000002C5C85FE) >> 64;
            if (x & 0x20000000 > 0) result = (result * 0x100000000162E42FF) >> 64;
            if (x & 0x10000000 > 0) result = (result * 0x1000000000B17217F) >> 64;
            if (x & 0x8000000 > 0) result = (result * 0x100000000058B90C0) >> 64;
            if (x & 0x4000000 > 0) result = (result * 0x10000000002C5C860) >> 64;
            if (x & 0x2000000 > 0) result = (result * 0x1000000000162E430) >> 64;
            if (x & 0x1000000 > 0) result = (result * 0x10000000000B17218) >> 64;
            if (x & 0x800000 > 0) result = (result * 0x1000000000058B90C) >> 64;
            if (x & 0x400000 > 0) result = (result * 0x100000000002C5C86) >> 64;
            if (x & 0x200000 > 0) result = (result * 0x10000000000162E43) >> 64;
            if (x & 0x100000 > 0) result = (result * 0x100000000000B1721) >> 64;
            if (x & 0x80000 > 0) result = (result * 0x10000000000058B91) >> 64;
            if (x & 0x40000 > 0) result = (result * 0x1000000000002C5C8) >> 64;
            if (x & 0x20000 > 0) result = (result * 0x100000000000162E4) >> 64;
            if (x & 0x10000 > 0) result = (result * 0x1000000000000B172) >> 64;
            if (x & 0x8000 > 0) result = (result * 0x100000000000058B9) >> 64;
            if (x & 0x4000 > 0) result = (result * 0x10000000000002C5D) >> 64;
            if (x & 0x2000 > 0) result = (result * 0x1000000000000162E) >> 64;
            if (x & 0x1000 > 0) result = (result * 0x10000000000000B17) >> 64;
            if (x & 0x800 > 0) result = (result * 0x1000000000000058C) >> 64;
            if (x & 0x400 > 0) result = (result * 0x100000000000002C6) >> 64;
            if (x & 0x200 > 0) result = (result * 0x10000000000000163) >> 64;
            if (x & 0x100 > 0) result = (result * 0x100000000000000B1) >> 64;
            if (x & 0x80 > 0) result = (result * 0x10000000000000059) >> 64;
            if (x & 0x40 > 0) result = (result * 0x1000000000000002C) >> 64;
            if (x & 0x20 > 0) result = (result * 0x10000000000000016) >> 64;
            if (x & 0x10 > 0) result = (result * 0x1000000000000000B) >> 64;
            if (x & 0x8 > 0) result = (result * 0x10000000000000006) >> 64;
            if (x & 0x4 > 0) result = (result * 0x10000000000000003) >> 64;
            if (x & 0x2 > 0) result = (result * 0x10000000000000001) >> 64;
            if (x & 0x1 > 0) result = (result * 0x10000000000000001) >> 64;

            result *= uint256(WAD);
            result >>= (191 - (x >> 64));
        }
    }
}

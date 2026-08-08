"""Stress test the money paths on a local EVM. No testnet, no gas, no waiting.

    python engine/test_vault.py

Every test here is about custody: can a depositor always get their money back,
under every ordering of redline / reset / withdraw that an operator can produce.
A vault that loses track of who owns what is worse than no vault.
"""

import json

import solcx
from eth_tester import EthereumTester, PyEVMBackend
from web3 import EthereumTesterProvider, Web3

from deploy import REGIME_THRESHOLD, SOLC_VERSION, SOURCE, WAD, hmm_args
from oracle import THRESHOLD

ETH = 10**18


def deploy_local():
    solcx.install_solc(SOLC_VERSION)
    compiled = solcx.compile_source(
        SOURCE.read_text(encoding="utf-8"),
        output_values=["abi", "bin"],
        solc_version=SOLC_VERSION,
        evm_version="shanghai",   # py-evm backend does not implement Cancun
        optimize=True,
    )["<stdin>:RegimeVault"]

    w3 = Web3(EthereumTesterProvider(EthereumTester(PyEVMBackend())))
    oracle, alice, bob = w3.eth.accounts[:3]
    w3.eth.default_account = oracle

    tx = w3.eth.contract(abi=compiled["abi"], bytecode=compiled["bin"]).constructor(
        int(THRESHOLD), int(REGIME_THRESHOLD * WAD), hmm_args()
    ).transact()
    address = w3.eth.wait_for_transaction_receipt(tx).contractAddress
    return w3, w3.eth.contract(address=address, abi=compiled["abi"]), oracle, alice, bob


def reverts(fn, *args, **kw):
    """True if the call reverts. Used to assert a guard actually guards."""
    try:
        fn(*args, **kw)
        return False
    except Exception:
        return True


def force_redline(c, oracle):
    """Drive both keys past their thresholds with a violent observation."""
    for _ in range(6):
        c.functions.tick(100, -8 * 10**16).transact({"from": oracle})  # -8% bar
    assert c.functions.latestScore().call() >= THRESHOLD
    assert c.functions.regimeProb().call() >= int(REGIME_THRESHOLD * WAD), "HMM did not confirm"
    c.functions.redline().transact({"from": oracle})
    assert c.functions.currentMode().call() == 1


def withdraw_net(w3, c, who):
    """Withdraw and return the balance delta net of gas, so the assert is exact."""
    before = w3.eth.get_balance(who)
    r = w3.eth.wait_for_transaction_receipt(c.functions.withdraw().transact({"from": who}))
    fee = r["gasUsed"] * w3.eth.get_transaction(r["transactionHash"])["gasPrice"]
    return w3.eth.get_balance(who) - before + fee


def solvency(w3, c):
    """The contract must always hold at least what it owes depositors."""
    held = w3.eth.get_balance(c.address)
    owed = c.functions.vaultBalance().call() + c.functions.bunkerBalance().call()
    return held, owed


def main():
    checks = []

    def check(name, ok):
        checks.append((name, ok))
        print(f"  {'PASS' if ok else 'FAIL'}  {name}")

    # ---------------------------------------------------------------- access
    print("\n[access control]")
    w3, c, oracle, alice, bob = deploy_local()
    check("non-oracle cannot tick", reverts(c.functions.tick(99, 0).transact, {"from": alice}))
    check("non-oracle cannot setMode", reverts(c.functions.setMode(1).transact, {"from": alice}))
    check("setMode rejects out-of-range mode",
          reverts(c.functions.setMode(2).transact, {"from": oracle}))

    # ---------------------------------------------------------------- deposits
    print("\n[deposits]")
    w3, c, oracle, alice, bob = deploy_local()
    check("zero deposit reverts",
          reverts(c.functions.deposit().transact, {"from": alice, "value": 0}))
    c.functions.deposit().transact({"from": alice, "value": 2 * ETH})
    c.functions.deposit().transact({"from": bob, "value": 3 * ETH})
    check("balances credited per user",
          c.functions.userBalances(alice).call() == 2 * ETH
          and c.functions.userBalances(bob).call() == 3 * ETH)
    check("vaultBalance is the sum", c.functions.vaultBalance().call() == 5 * ETH)
    held, owed = solvency(w3, c)
    check("contract holds what it owes", held == owed == 5 * ETH)

    # ---------------------------------------------------------------- redline gate
    print("\n[two-key gate]")
    check("redline blocked with no data", reverts(c.functions.redline().transact, {"from": bob}))
    for _ in range(6):
        c.functions.tick(10, -8 * 10**16).transact({"from": oracle})  # HMM hot, score low
    check("redline blocked when only the HMM agrees",
          reverts(c.functions.redline().transact, {"from": bob}))
    c.functions.tick(99, 0).transact({"from": oracle})               # score high, HMM cooling
    p_now = c.functions.regimeProb().call() / WAD
    c.functions.tick(99, -8 * 10**16).transact({"from": oracle})
    check("redline succeeds only when both keys turn (p was %.3f)" % p_now,
          not reverts(c.functions.redline().transact, {"from": bob}))
    check("anyone may pull the alarm, not just the oracle",
          c.functions.currentMode().call() == 1)
    check("double redline reverts", reverts(c.functions.redline().transact, {"from": alice}))

    # ---------------------------------------------------------------- custody
    print("\n[custody after redline]")
    check("funds moved to bunker",
          c.functions.bunkerBalance().call() == 5 * ETH and c.functions.vaultBalance().call() == 0)
    check("deposits blocked while redlined",
          reverts(c.functions.deposit().transact, {"from": alice, "value": ETH}))
    check("bob withdraws his full 3 MON from the bunker",
          withdraw_net(w3, c, bob) == 3 * ETH)
    check("bob cannot withdraw twice", reverts(c.functions.withdraw().transact, {"from": bob}))
    check("stranger with no balance cannot withdraw",
          reverts(c.functions.withdraw().transact, {"from": w3.eth.accounts[5]}))
    held, owed = solvency(w3, c)
    check("still solvent after partial withdrawal (%d held, %d owed)" % (held, owed),
          held == owed == 2 * ETH)

    # ---------------------------------------------------------------- THE ORDERING BUG
    print("\n[reset ordering — the demo button vs real custody]")
    c.functions.setMode(0).transact({"from": oracle})   # operator resets for another demo
    check("mode is CALM again", c.functions.currentMode().call() == 0)
    alice_owed = c.functions.userBalances(alice).call()
    check("alice is still owed %d wei on the books" % alice_owed, alice_owed == 2 * ETH)
    got = None
    try:
        got = withdraw_net(w3, c, alice)
    except Exception as e:
        print(f"        -> withdraw reverted: {str(e)[:100]}")
    check("alice can still withdraw after a reset", got is not None)
    check("alice received her full 2 MON", got == 2 * ETH)

    # ---------------------------------------------------------------- redline twice
    print("\n[second cycle]")
    w3, c, oracle, alice, bob = deploy_local()
    c.functions.deposit().transact({"from": alice, "value": ETH})
    force_redline(c, oracle)
    c.functions.setMode(0).transact({"from": oracle})
    c.functions.deposit().transact({"from": bob, "value": 4 * ETH})
    force_redline(c, oracle)
    held, owed = solvency(w3, c)
    check("accounting survives redline -> reset -> deposit -> redline (%d held, %d owed)"
          % (held, owed), held == owed)
    for who, amt in ((alice, ETH), (bob, 4 * ETH)):
        try:
            got = withdraw_net(w3, c, who)
        except Exception as e:
            got = f"reverted: {str(e)[:80]}"
        check("depositor recovers %d wei across two cycles (got %s)" % (amt, got), got == amt)
    check("contract is empty once everyone is paid", w3.eth.get_balance(c.address) == 0)

    # ---------------------------------------------------------------- staleness
    print("\n[freshness]")
    w3, c, oracle, alice, bob = deploy_local()
    c.functions.deposit().transact({"from": alice, "value": ETH})
    for _ in range(6):
        c.functions.tick(99, -8 * 10**16).transact({"from": oracle})
    w3.provider.ethereum_tester.time_travel(w3.eth.get_block("latest").timestamp + 600)
    check("stale data cannot authorise a redline",
          reverts(c.functions.redline().transact, {"from": bob}))

    failed = [n for n, ok in checks if not ok]
    print(f"\n{len(checks) - len(failed)}/{len(checks)} passed")
    if failed:
        print("\nFAILURES:")
        for n in failed:
            print(f"  - {n}")
        raise SystemExit(1)
    print("all money paths hold")


if __name__ == "__main__":
    main()

"""Compile and deploy RegimeVault to Monad testnet from PRIVATE_KEY.

    python engine/fit_hmm.py     # first: fit the model, writes hmm_params.json
    python engine/deploy.py      # then: deploy with those params baked in

Deploys from the oracle account by construction, so `oracle = msg.sender` can
never end up as the wrong address. Prints the line to paste into .env.
"""

import json

import solcx
from web3 import Web3

from oracle import CHAIN_ID, ROOT, RPC_URL, THRESHOLD, load_env, require

SOLC_VERSION = "0.8.24"
SOURCE = ROOT / "contracts" / "RegimeVault.sol"
PARAMS_PATH = ROOT / "hmm_params.json"

REGIME_THRESHOLD = 0.80   # P(turbulent) required alongside the deterministic score
WAD = 10**18


def compile_vault():
    solcx.install_solc(SOLC_VERSION)  # no-op once cached
    compiled = solcx.compile_source(
        SOURCE.read_text(encoding="utf-8"),
        output_values=["abi", "bin"],
        solc_version=SOLC_VERSION,
        optimize=True,
        optimize_runs=200,
    )
    contract = compiled["<stdin>:RegimeVault"]
    return contract["abi"], contract["bin"]


def hmm_args():
    p = json.loads(PARAMS_PATH.read_text(encoding="utf-8"))["onchain"]
    order = ["MU_CALM", "MU_TURB", "INV_CALM", "INV_TURB", "LN_SIGMA_RATIO", "A01", "A11", "P0"]
    return [p[k] for k in order]


def main():
    load_env()
    private_key = require("PRIVATE_KEY", length=66)

    w3 = Web3(Web3.HTTPProvider(RPC_URL))
    account = w3.eth.account.from_key(private_key)
    abi, bytecode = compile_vault()
    hmm = hmm_args()

    print(f"deploying from {account.address} "
          f"({w3.from_wei(w3.eth.get_balance(account.address), 'ether')} MON)")
    print(f"bytecode: {len(bytecode) // 2:,} bytes (Monad limit 256 KB, Ethereum 24 KB)")
    print(f"HMM params: {hmm}")

    ctor = w3.eth.contract(abi=abi, bytecode=bytecode).constructor(
        int(THRESHOLD), int(REGIME_THRESHOLD * WAD), hmm
    )
    tx = ctor.build_transaction({
        "chainId": CHAIN_ID,
        "from": account.address,
        "nonce": w3.eth.get_transaction_count(account.address),
    })
    tx["gas"] = int(tx["gas"] * 1.075)  # Monad wants headroom on the limit

    receipt = w3.eth.wait_for_transaction_receipt(
        w3.eth.send_raw_transaction(account.sign_transaction(tx).raw_transaction)
    )
    address = receipt.contractAddress

    assert w3.eth.get_code(address), "deploy mined but left no code"
    (ROOT / "abi.json").write_text(json.dumps(abi, indent=2), encoding="utf-8")

    print(f"\ndeployed at {address}  (gas used {receipt.gasUsed:,})")
    print(f"https://testnet.monadscan.com/address/{address}\n")
    print("put these two lines in .env:")
    print(f"CONTRACT_ADDRESS={address}")
    print(f"VITE_CONTRACT_ADDRESS={address}")


if __name__ == "__main__":
    main()

"""Compile and deploy RedlineVault to Monad testnet from PRIVATE_KEY.

    python engine/deploy.py

Deploys from the oracle account by construction, so `oracle = msg.sender` in
the constructor can never end up as the wrong address. Prints the line to
paste into .env.
"""

import json

import solcx
from web3 import Web3

from oracle import CHAIN_ID, ROOT, RPC_URL, THRESHOLD, load_env, require

SOLC_VERSION = "0.8.24"
SOURCE = ROOT / "contracts" / "RedlineVault.sol"


def compile_vault():
    solcx.install_solc(SOLC_VERSION)  # no-op once cached
    compiled = solcx.compile_source(
        SOURCE.read_text(encoding="utf-8"),
        output_values=["abi", "bin"],
        solc_version=SOLC_VERSION,
    )
    contract = compiled["<stdin>:RedlineVault"]
    return contract["abi"], contract["bin"]


def main():
    load_env()
    private_key = require("PRIVATE_KEY", length=66)

    w3 = Web3(Web3.HTTPProvider(RPC_URL))
    account = w3.eth.account.from_key(private_key)
    abi, bytecode = compile_vault()

    print(f"deploying from {account.address} ({w3.from_wei(w3.eth.get_balance(account.address), 'ether')} MON)")

    tx = w3.eth.contract(abi=abi, bytecode=bytecode).constructor(int(THRESHOLD)).build_transaction({
        "chainId": CHAIN_ID,
        "from": account.address,
        "nonce": w3.eth.get_transaction_count(account.address),
    })
    tx["gas"] = int(tx["gas"] * 1.075)  # Monad wants headroom on the limit

    tx_hash = w3.eth.send_raw_transaction(account.sign_transaction(tx).raw_transaction)
    receipt = w3.eth.wait_for_transaction_receipt(tx_hash)
    address = receipt.contractAddress

    assert w3.eth.get_code(address), "deploy mined but left no code"
    (ROOT / "abi.json").write_text(json.dumps(abi, indent=2), encoding="utf-8")

    print(f"\ndeployed at {address}")
    print(f"https://testnet.monadscan.com/address/{address}\n")
    print("put these two lines in .env:")
    print(f"CONTRACT_ADDRESS={address}")
    print(f"VITE_CONTRACT_ADDRESS={address}")


if __name__ == "__main__":
    main()

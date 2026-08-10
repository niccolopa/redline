<div align="center">

#  REDLINE

![Monad Blitz](https://img.shields.io/badge/Monad_Blitz-Showcase_%233-836EF9?style=flat-square)
![Network](https://img.shields.io/badge/Network-Monad_Testnet-836EF9?style=flat-square)
![Reaction Time](https://img.shields.io/badge/Reaction_Time-417ms-FF2D2D?style=flat-square)
![Custody Tests](https://img.shields.io/badge/Custody_Tests-27%2F27_Passing-brightgreen?style=flat-square)
![Solidity](https://img.shields.io/badge/Solidity-363636?style=flat-square&logo=solidity&logoColor=white)
![Python](https://img.shields.io/badge/Python-3776AB?style=flat-square&logo=python&logoColor=white)
![React](https://img.shields.io/badge/React-61DAFB?style=flat-square&logo=react&logoColor=black)
![License: MIT](https://img.shields.io/badge/License-MIT-yellow?style=flat-square)
![Built with Claude Code](https://img.shields.io/badge/Built_with-Claude_Code-000000?style=flat-square)

<img width="1920" height="1080" alt="image" src="https://github.com/user-attachments/assets/4972adc7-767b-4da8-8b8b-ba38f517485c" />

<img width="1920" height="1080" alt="image" src="https://github.com/user-attachments/assets/631e3a58-3641-41c5-9514-ab38493c36e1" />


### The vault that saves itself.

**Monad London Blitz — 8 August 2026**

*A savings vault that watches the real market and pulls its own money to safety
the moment a crash begins. It decides in under half a second, using mathematics
anyone can check — and half of that mathematics runs inside the smart contract itself.*

<br>

|  Reaction time |  Model accuracy |  Custody tests |  False alarms |
|:---:|:---:|:---:|:---:|
| **145–456 ms** | **3.4 × 10⁻¹³** | **27 / 27** | **−66 %** |
| send → receipt | on-chain vs reference | all passing | vs one detector alone |

</div>

---

## The four hours this was built for

**12 May 2022.** The UST stablecoin had broken its peg. LUNA was collapsing.
Over four hours, ETH fell from **$2,130.75** to **$1,871.18** — down 12.18 %.

Nobody rang a bell. There was no announcement. The people who got out were the
ones watching a screen at 4 a.m.

```
$2,130 ┤ ▔▔▔╲▁▁▁
       │        ╲▁▁▁▁▁▁╲
       │                 ╲▁▁▁▁▁╲
       │                          ╲▁▁▁▁▁▁╲
$1,871 ┤                                   ╲▁▁▁  ← −12.18 %
       └──────────────────────────────────────────
       00:24 UTC          02:00              04:23
```

**Humans react in minutes. Redline reacts in milliseconds.**

This project replays those exact four hours — real Binance data, every bar — and
shows a vault detecting the crash and sheltering its funds automatically, on
Monad, in **417 milliseconds**.

---

## What it does

Three things, in plain terms:

<table>
<tr>
<td width="33%" valign="top">

###  It watches
Reads real ETH/USD prices from Binance and scores how dangerous the market
looks, from **0 to 100**.

</td>
<td width="33%" valign="top">

###  It decides
Two completely different mathematical methods must **both** agree that a crash
is happening. One bad minute is not enough.

</td>
<td width="33%" valign="top">

###  It acts
Moves every deposit into a protected "bunker", blocks new deposits, and does it
in one transaction — **under half a second**.

</td>
</tr>
</table>

> ###  The Security system
> No model in this system is permitted to invent a number that moves money.
> Every figure that can trigger the alarm comes from a fixed formula or a model
> whose parameters are frozen into the contract at deployment and cannot be changed.

### What makes it different

| | |
|---|---|
|  **The risk score lives on-chain** | It is a public good. Any other protocol can read it and make its own decision. The vault is just the first subscriber. |
|  **The alarm is public but math-gated** | *Anyone in the world* can call `redline()`. The contract only lets it ring when the data says danger. You cannot trigger it by wanting to. |
| ⛓️ **The model runs inside the contract** | The oracle does not post an opinion. It posts a raw measurement, and the blockchain performs the statistical inference itself. Nobody has to trust our arithmetic. |

---

#  The evidence

Everything below was measured, not estimated. Every command is reproducible.

## Test 1 — Does the on-chain model actually match the real model?

The hard part of putting statistics inside a smart contract is that Solidity has
no decimals. We rebuilt the model in fixed-point integer arithmetic and then
checked it against the real thing, bar by bar, for all 240 bars of the crash.

```console
$ python engine/test_filter.py

replaying 240 bars through the contract ...
  bar   0  chain 0.017092824  ref 0.017092824
  bar  60  chain 0.827403760  ref 0.827403760
  bar 120  chain 0.999564031  ref 0.999564031
  bar 180  chain 0.993233050  ref 0.993233050

max  abs difference: 3.412e-13
mean abs difference: 6.182e-14
bars over 0.80 — chain 106, ref 106

OK — on-chain fixed point matches float64 reference within 1e-06
```

>  **Agreement to 13 decimal places**, and both count exactly 106 alarm bars.
> The number the contract computes *is* the number the model says.

## Test 2 — Can anyone lose their money?

This is the test that matters. We ran 27 scenarios on a local blockchain,
trying every order of events an operator could produce.

```console
$ python engine/test_vault.py

[access control]   ✓ non-oracle cannot post data, change mode, or set a bad mode
[deposits]         ✓ zero rejected · credited per user · contract holds what it owes
[two-key gate]     ✓ blocked with no data
                   ✓ blocked when only ONE detector agrees
                   ✓ anyone may fire it · double-firing reverts
[custody]          ✓ withdraw from the bunker · no double withdraw · strangers blocked
[reset ordering]   ✓ withdraw still works after alarm → reset
[second cycle]     ✓ alarm → reset → deposit → alarm → everyone paid → contract empty
[freshness]        ✓ stale data cannot authorise an alarm

27/27 passed — all money paths hold
```

###  This test found two bugs that would have locked user funds

We are including these because a test suite that never fails is not a test suite.

<table>
<tr><td width="50%" valign="top">

**Bug 1 — Reset stranded deposits**

`withdraw()` decided which pot to pay from based on the vault's *current* mode.
After alarm → reset, the money was in the bunker but CALM mode made the code
subtract from an empty vault.

**Result:** arithmetic underflow. A depositor's funds became permanently
unwithdrawable.

</td><td width="50%" valign="top">

**Bug 2 — A second alarm erased the first**

`redline()` used `bunkerBalance = vaultBalance` — an assignment, not an addition.
A second cycle overwrote the first cycle's accounting.

**Result:** the contract held 5 MON while its books said 4. One MON unaccounted for.

</td></tr>
</table>

Both fixed. Withdrawals now drain the bunker first, and the alarm accumulates,
so this always holds no matter what order things happen in:

```
vaultBalance + bunkerBalance  =  sum of every user's balance
```

## Test 3 — Is the second detector worth having?

We ran both detectors across **all 44,640 bars of May 2022** and counted how often
each would have fired.

| Trigger condition | Bars in breach | |
|---|---:|---|
| Stress meter alone | 383 | |
| Regime model alone | 2,029 | |
| **Both must agree** | **131** | **↓ 66 % fewer false alarms** |

>  Requiring both cuts false triggers by **two thirds**. When the failure mode
> is moving somebody's money for no reason, that is the number that matters.

## Test 4 — How fast is it really?

Wall-clock time from sending the transaction to holding its receipt, using
Monad's synchronous transaction endpoint.

| Operation | Measured |
|---|---|
| `tick()` — post data + run the model | **145 – 456 ms** |
| `redline()` — **the alarm firing** | **417 ms** |
| `setMode()` — demo reset | 291 – 442 ms |

*When the shared public RPC rate-limits us, the oracle falls back to a slower
send-and-poll path and reports `ASYNC` — 809 ms observed. The interface always
labels which path produced the number.*

## Test 5 — Does the maths hold up on its own?

```console
$ python engine/risk_engine.py --selftest
selftest OK — 44,371 scored bars, max 100.00, replay window peaks at 97.23
```

Checks that the weights sum to 1, that the score can never escape 0–100, that a
steady trend produces zero volatility, and that the demo window actually contains
a crash.

### Reproduce all of it

```bash
python engine/risk_engine.py --selftest   # the score's own maths
python engine/fit_hmm.py                  # retrain the model, print the fit
python engine/test_filter.py              # on-chain vs reference → 3.4e-13
python engine/test_vault.py               # 27 custody stress tests
```

---

#  Installation

## What you need first

| | |
|---|---|
| **Python 3.11 or newer** | [python.org/downloads](https://python.org/downloads) — tick *"Add Python to PATH"* on Windows |
| **Node.js 20 or newer** | [nodejs.org](https://nodejs.org) |
| **MetaMask** | Browser extension, with the Monad Testnet network added |
| **Testnet MON** | Free from a Monad faucet — this is play money, not real currency |

## Step 1 — Get the code

```bash
git clone <this-repository>
cd redline
```

## Step 2 — Python environment

<details>
<summary><b>Windows (PowerShell)</b></summary>

```powershell
python -m venv .venv
Set-ExecutionPolicy -Scope Process -ExecutionPolicy RemoteSigned
.\.venv\Scripts\Activate.ps1
```
</details>

<details>
<summary><b>macOS / Linux</b></summary>

```bash
python3 -m venv .venv
source .venv/bin/activate
```
</details>

Then, with the environment active:

```bash
pip install pandas numpy web3 hmmlearn scikit-learn py-solc-x eth-tester py-evm
```

| Package | What it is for |
|---|---|
| `pandas`, `numpy` | The rolling calculations behind the risk score |
| `hmmlearn`, `scikit-learn` | Training the regime model (once, offline) |
| `web3` | Talking to Monad |
| `py-solc-x` | Compiling the smart contract |
| `eth-tester`, `py-evm` | A local blockchain for the custody tests — no testnet needed |

## Step 3 — Frontend

```bash
cd frontend
npm install
cd ..
```

## Step 4 — Add the network to MetaMask

| Field | Value |
|---|---|
| Network name | Monad Testnet |
| RPC URL | `https://testnet-rpc.monad.xyz` |
| Chain ID | `10143` |
| Currency symbol | `MON` |
| Block explorer | `https://testnet.monadscan.com` |

## Step 5 — Create `.env` in the project root

```ini
PRIVATE_KEY=0x<a throwaway key, funded with testnet MON>
CONTRACT_ADDRESS=0xc0242985550ec693DEed2b00503D7c80C4f354CC
VITE_CONTRACT_ADDRESS=0xc0242985550ec693DEed2b00503D7c80C4f354CC
```

> ###  Read this before pasting a key
> This key **signs transactions automatically, with no wallet prompt** — that is
> what an oracle has to do. Use a throwaway account that has never held, and will
> never hold, real assets on any network. `.env` is gitignored and is never committed.

<details>
<summary><b>Optional — deploy your own contract instead of using ours</b></summary>

```bash
python engine/fit_hmm.py    # trains the model → hmm_params.json
python engine/deploy.py     # compiles, deploys, prints the .env lines to paste
```

`deploy.py` deploys from your `PRIVATE_KEY`, so the contract's operator address
is correct by construction — it cannot end up as the wrong account.
</details>

---

# ▶ Running it

One command starts **all three parts** — the risk engine, the oracle, and the web
interface — with colour-coded logs.

```bash
cd frontend

npm run dev      # LIVE   — real ETH/USDT prices, streaming right now
npm run demo     # REPLAY — the May 2022 crash, the one that actually fires
```

Then open **http://localhost:5173**

```console
 REDLINE  LIVE — ETH/USDT from the Binance public API
[engine] serving state on http://127.0.0.1:8000
[engine] LIVE ETH/USDT from Binance — 999 bars warmed up, latest $1,924.75
[oracle] >>> CONNECTED TO MONAD TESTNET: True
[oracle] tick() 258ms SYNC  P(turbulent)=0.0167
```

## Which mode should I run?

| | `npm run dev` — **LIVE** | `npm run demo` — **REPLAY** |
|---|---|---|
| **Data** | Real ETH/USDT, streaming now | Real ETH/USDT, May 2022, recorded |
| **Speed** | 1 new bar per **minute** | 1 bar per **second** (60× real time) |
| **Will the alarm fire?** | 🟢 Almost certainly not | 🔴 **Yes, reliably** |
| **Use it to show** | The feed is genuinely live | The circuit breaker actually working |

> ###  Both modes use real market data
> Neither is simulated. **A live market is calm almost all of the time** — that is
> the honest reason the replay exists, and it is the whole point of the product.
> The interface always shows a green **LIVE** or amber **REPLAY** banner, so the
> two can never be confused.

##  If the score looks frozen, it is working

In LIVE mode the score is recalculated **once a minute**, when each one-minute bar
closes. It is *supposed* to hold still in between. The price and a countdown keep
moving so you can see the system is alive:

```
poll 1: live $1923.46 | score  8.48 | next bar  1s
poll 2: live $1923.42 | score  8.48 | next bar  0s
poll 3: live $1923.43 | score 21.46 | next bar 47s   ← new bar closed
```

## Using the interface

The page is built so a visitor with no finance background can read the top, and a
quant can read the bottom. Nothing is hidden — the technical detail is folded into
expandable sections.

1. **Data source banner** — LIVE or REPLAY, live price, countdown, feed heartbeat
2. **What is happening to your money** — `IN THE VAULT` or `MOVED TO SAFETY`
3. **Market risk right now** — the 0–100 score against the red alarm line
4. **Two independent checks** — both must agree before the alarm can ring
5. **Your money** — connect a wallet, deposit, withdraw
6. **Details** — the full arithmetic, data provenance, speed, and a glossary

**What does "Deposit" do?** It puts testnet MON into the vault so you can watch
the circuit breaker protect it. It is play money with no value. *Withdraw* returns
your full balance at any time, in either state — guaranteed by Test 2 above, not
by promise.

---

#  How it works

No formulas in this section. Everything here is described in words; the
mathematics is in [Appendix A](#appendix-a--the-formal-mathematics) at the end.

## The problem with "the price went down"

A price falling is not, by itself, dangerous. Prices fall all day. What makes a
crash a crash is that the market's **whole character** changes — it becomes
violent, one-directional, and crowded, all at once.

So Redline does not watch the price. It watches **three symptoms**, and then asks
a second, completely separate question: *has the market changed mood?*

## Detector 1 — three warning lights 🚦

Think of a car dashboard with three lights. Each one measures a different symptom
of a market in trouble.

<table>
<tr><td width="34%" valign="top">

###  Light 1 — Shaking
**"How violently is the price swinging?"**

We look at the last 30 minutes and measure how much the price has been bouncing
around. A calm market drifts. A frightened one convulses.

**Worth 50 % of the score** — this is the strongest single symptom of a crash.

</td><td width="33%" valign="top">

###  Light 2 — Falling
**"How hard is it dropping *right now*?"**

The size of this minute's fall. Only falls count — a sharp rally does not turn
the light on, because a vault does not need protecting from gains.

**Worth 35 % of the score.**

</td><td width="33%" valign="top">

###  Light 3 — Crowding
**"Is everyone rushing for the exit?"**

How much trading is happening now compared with a normal recent minute. Panic is
loud: crashes come with a surge of volume.

**Worth 15 % of the score.**

</td></tr>
</table>

### The trick that makes it work: comparing to *normal*

A move of 0.4 % means nothing on its own. Is that big? It depends entirely on
what has been normal lately.

So for each light, we do not ask *"how big is this?"* — we ask
**"how unusual is this, compared with the last four hours?"**

That comparison is called a **z-score**, and it is the single most important idea
in the whole project:

| Z-score | Meaning in plain words |
|:---:|---|
| **0** | Completely ordinary. Exactly average. |
| **1** | Slightly unusual — happens often. |
| **2** | Genuinely unusual. |
| **3+** | **Rare. Something is wrong.** |

We treat **3 as the ceiling**: anything at or beyond 3 turns that light fully on
(100 out of 100). Anything at or below average leaves it fully off (0).

This is why the score works on any asset at any price. It never measures dollars —
it measures *strangeness*.

### Adding the lights up

Each light gives a number from 0 to 100. We multiply each by its importance and
add them:

```
  Shaking   99.0  ×  0.50  =  49.50 points
  Falling  100.0  ×  0.35  =  35.00 points
  Crowding  84.8  ×  0.15  =  12.72 points
                              ─────────────
            RISK SCORE     =   97.23  / 100
```

Because the three weights add up to exactly 1, the total can never escape 0–100.
That is guaranteed by construction, not by clipping the result afterwards.

**The alarm line is 70.**

```
 0        20        40        60    │   80       100
 ├─────────┼─────────┼─────────┼────┼────┼─────────┤
 ████████████████████████████████████████████████▏     97.23  🔴 DANGER
                                    ▲
                              ALARM LINE (70)
```

## Detector 2 — the weather forecaster 

The three lights have one weakness: **they have no memory.** A single violent
minute can push the score over 70 even if the market is otherwise fine.

So the second detector works on a completely different principle. It is a
**Hidden Markov Model**, and the easiest way to understand it is as a weather
forecaster.

A forecaster does not just look out of the window. They know two things:

1. **What storms look like.** Storm days and calm days have different *characters*.
2. **Weather is sticky.** If it was stormy an hour ago, it is probably still stormy.
   Weather does not flip randomly minute to minute.

Our model learns exactly these two things from historical data:

| What it learns | What we measured |
|---|---|
| What a **calm** market looks like | Typical minute-to-minute movement of **0.126 %** |
| What a **turbulent** market looks like | Typical movement of **0.470 %** — **3.7× larger** |
| How likely calm turns turbulent | About **0.4 %** chance per minute |
| **How long turbulence lasts** | **≈ 16 minutes** once it starts |

That last row is the valuable one. It is what the three lights cannot express:
**turbulence is sticky.** Because the model knows this, it does not panic at one
bad minute — and equally, it does not relax the instant one calm minute appears.

Instead of a score, this detector outputs a **probability**: *"there is a 93 %
chance the market is currently in its turbulent state."* The alarm needs **80 %**.

> ### 🔬 The honest-scientist detail
> Most tutorials analyse a regime model by running it over the *whole* dataset at
> once. That lets it label 10 a.m. using information from 3 p.m. — it is looking
> into the future, and it makes results look spectacular that would never work live.
>
> Redline uses the **forward filter**: at every minute it only knows what has
> happened *up to that minute*. It is the only honest way to run this live — and,
> conveniently, the only version cheap enough to run inside a smart contract.

### And we trained it on the right data

The model was trained on **1–11 May 2022** and stops **1,000 minutes before** the
crash we demonstrate. It has never seen the event it detects.

Training on the crash you then demo is circular reasoning, and it is the first
thing a sharp reviewer will attack. On data it had never seen, it flagged
**106 of the 240 crash minutes** as turbulent.

## Two locks on the same door 

Neither detector can fire the alarm alone.

```
   ┌────────────────────┐     ┌────────────────────┐
   │    Three lights    │     │    Forecaster      │
   │                    │     │                    │
   │  Score ≥ 70 ?      │     │  Chance ≥ 80 % ?   │
   │  fast, no memory   │     │  slow, remembers   │
   └─────────┬──────────┘     └─────────┬──────────┘
             │                          │
             └──────────┐   ┌───────────┘
                     ┌──▼───▼──┐
                     │   AND   │   ← plus: data < 2 min old
                     └────┬────┘
                          ▼
                    ALARM CAN RING
              anyone may pull it — nobody
              can pull it without the maths
```

They are deliberately different: one is a fixed formula that reacts instantly, one
is a learned model with memory. Requiring both cut false alarms by **66 %**
(Test 3).

## What actually happens when it fires

1. Every deposit moves from the **vault** to the **bunker** — same contract,
   separate accounting
2. New deposits are **blocked**
3. Withdrawals **keep working** — always, in either state
4. The whole thing takes **417 milliseconds**

## The variables, one line each

Every symbol used in [Appendix A](#appendix-a--the-formal-mathematics), with what
it means and what it read at the worst minute of the crash.

| Symbol | Plain name | What it measures | Calm | At the crash |
|:---:|---|---|---|---|
| `P` | Price | ETH price in dollars | $2,130 | $1,871 |
| `V` | Volume | ETH traded in that minute | ~4,300 | 15,303 |
| `r` | Return | This minute's price change | ±0.1 % | **−1.528 %** |
| `σ` | Volatility | How much prices have swung over 30 min | 0.126 %/min | **0.429 %/min** |
| `VS` | Volume shock | This minute's volume ÷ normal volume | ~1.0× | **3.54×** |
| `z` | Z-score | How unusual something is vs the last 4 h | ~0 | **+2.97, +4.63** |
| `C` | Component | One warning light, scaled 0–100 | ~0 | 99.0 / 100.0 / 84.8 |
| `S` | **Risk score** | The three lights combined, 0–100 | 0–20 | **97.23** |
| `p` | **Regime probability** | Chance the market is turbulent, 0–1 | 0.06 | **1.0000** |
| `a₀₁` | Transition | Chance calm turns turbulent, per minute | 0.0039 | — |
| `a₁₁` | Persistence | Chance turbulence continues | 0.9382 | — |

---

#  How Redline uses Monad

We were asked to explore the limits of Monad. Here is what we actually used —
and, just as importantly, what we did **not** claim.

### Used, and load-bearing

| Feature | How Redline uses it | Evidence |
|---|---|---|
| **`eth_sendRawTransactionSync`** | The oracle gets the full receipt back *in the same call*. We read the new probability straight out of the receipt's event log instead of making a second request — one round trip per bar. | **145–456 ms** measured |
| **256 KB contract limit** | The contract carries a complete fixed-point exponential function inline. Ethereum's 24 KB limit would force splitting it across libraries and proxies. | 6,820 bytes deployed |
| **JIT compilation** | The model is an arithmetic-heavy inner loop — precisely the workload that benefits from bytecode compiled to native and cached. | `tick()` ≈ 112k gas |
| **MonadBFT, 600 ms finality** | The alarm is *final* in one round, not "probably final". A circuit breaker that might un-fire is not a circuit breaker. | — |
| **MIP-8 cold-slot gas** *(upcoming)* | The model re-touches the same few hot storage slots every minute; the entire belief state is one number. | — |

> ### The novel mechanic this enables
> Because Monad makes per-minute on-chain mathematics cheap and fast enough,
> **the oracle can stop posting opinions and post only observations.** It hands the
> chain a raw measurement, and the chain performs the statistical inference itself.
> Nobody needs to trust the oracle's arithmetic — only its data feed.

### Deliberately not claimed

A technical judge will catch overreach, so:

-  **Parallel execution does not help us.** A Markov filter is inherently
  serial — each minute depends on the one before. We benefit only in the general
  sense that the chain is faster.
-  **MonadDB** we benefit from passively; we did nothing clever with it.
-  **Execution event streams** are the obvious next step — the interface would
  subscribe to events straight from the node, skipping the polling entirely — but
  we have not built it, so we do not claim it.

---

#  Architecture

```
  Binance public REST                      data/crash.csv
  ETH/USDT 1m klines  (LIVE)               May 2022, 44,640 bars  (REPLAY)
          │                                        │
          └──────────────┬─────────────────────────┘
                         ▼
         engine/risk_engine.py         pandas · deterministic
           · the three warning lights → score 0–100
           · serves :8000  ─────────────────────────┐
           · writes events.jsonl                    │
                         │                          │
                         ▼                          │
             engine/oracle.py          web3.py      │
               tick(score, priceChange)             │
               eth_sendRawTransactionSync           │
                         │                          │
                         ▼                          │
    ┌────────────────────────────────────────┐      │
    │  RegimeVault.sol      MONAD TESTNET    │      │
    │                                        │      │
    │  THE FORECASTER RUNS HERE              │      │
    │    predict → likelihood → update       │      │
    │    one exponential per minute          │      │
    │                                        │      │
    │  redline() requires ALL of:            │      │
    │    score       ≥ 70                    │      │
    │    probability ≥ 0.80                  │      │
    │    data age    ≤ 120 s                 │      │
    └────────────────────────────────────────┘      │
                         │                          │
                         ▼                          ▼
              frontend/  React + wagmi/viem  ← reads both
```

<details>
<summary><b>Repository layout</b></summary>

```
contracts/RegimeVault.sol   the vault + the on-chain forecaster
engine/risk_engine.py       live + replay feed, the score, HTTP endpoint
engine/fit_hmm.py           trains the regime model → hmm_params.json
engine/oracle.py            posts observations on-chain
engine/deploy.py            compile + deploy with the trained model baked in
engine/test_vault.py        27 custody stress tests (local blockchain)
engine/test_filter.py       on-chain vs reference model equivalence
frontend/dev.mjs            one-command launcher for all three processes
frontend/src/App.tsx        the dashboard
hmm_params.json             the trained model — provenance, committed
data/crash.csv              44,640 minutes of May 2022 ETH/USDT
```
</details>

---

#  Questions we expect

<details open>
<summary><b>Why is this useful? Isn't it just a stop-loss?</b></summary>

A stop-loss triggers on a **price**. Redline triggers on a **regime** — the
statistical character of the market. Price-based stops fire on any dip, including
the ones that recover two minutes later. Regime detection answers a different
question: *has the market changed its mind about how it behaves?*

What makes it useful on-chain is that the **evidence and the action live in the
same place**. A conventional risk system detects danger in one system and executes
in another, with a human or a keeper in between. Here the condition is checked and
the funds move in a single atomic transaction, in under half a second, and anyone
can verify the arithmetic afterwards.
</details>

<details>
<summary><b>Where would this actually be used?</b></summary>

- **Lending protocols** — pause new borrows or tighten collateral requirements
  when the regime flips, instead of waiting for liquidations to cascade
- **Liquidity provision and vault strategies** — pull liquidity before a
  volatility spike turns into impermanent loss
- **Structured products** — an auditable de-risking trigger that needs no trusted
  operator to press a button
- **A public risk oracle** — any contract can read the score and decide for itself

That last one is the real product. **The vault is a demonstration; the score is
the infrastructure.**
</details>

<details>
<summary><b>Why does it need a blockchain at all?</b></summary>

Because the trigger must be **credibly neutral**. If the risk model runs on a
company's server, users must trust that the company will fire it fairly, will not
fire it early to front-run them, and will not quietly retune it afterwards.

Here the threshold is immutable, the model's parameters are immutable, the
inference is executed by the chain, and the alarm is callable by anyone. There is
no privileged party who decides when the alarm rings — only mathematics that
everyone can recompute.
</details>

<details>
<summary><b>How does it scale?</b></summary>

**Per-minute cost is constant.** The forecaster's work does not grow with time —
its entire memory is a single number. Adding more assets is linear, not
quadratic: each market is an independent model with its own storage slot, and
Monad's parallel execution *does* help across independent assets even though it
cannot help within one serial model.

**The bottleneck we hit was the RPC, not the chain.** At one bar per second the
shared public endpoint rate-limits us. Fixes, in order of laziness: a dedicated
RPC endpoint; request batching (already implemented — about 9 reads collapse into
1); or batching several minutes into one transaction. None are chain limitations.

**Cost at realistic frequency is trivial.** Real risk systems do not need
second-by-second resolution. At one bar per minute, a single asset costs about
0.6 MON per hour of testnet gas.
</details>

<details>
<summary><b>How adaptable is it?</b></summary>

- **Weights, windows and thresholds** are constants at the top of one file.
  Retuning is editing three numbers.
- **The trained model** is passed in at deployment. Retraining on another asset,
  timeframe or period is `fit_hmm.py && deploy.py`.
- **The data source** is one function. The Binance data format matches our
  historical file exactly, so live and recorded data share identical maths.
  Coinbase and Kraken were both tested and reachable.
- **More regimes** — the contract handles two states because two need only *one*
  exponential. Three is a straightforward generalisation.
</details>

<details>
<summary><b>Is the AI making any decisions?</b></summary>

No, and this is enforced structurally rather than promised:

- the score is a weighted sum of clamped z-scores — reproducible by hand
- the model's parameters are immutable from deployment and cannot be swapped
- the inference is executed by the blockchain, and verified to 3.4 × 10⁻¹³ against
  an independent implementation

An LLM's only role in this product is narrating what happened after the fact.
That is the Security system.
</details>

---

#  Honest limitations

We would rather state these than be caught by them.

| | |
|---|---|
|  **The live market will not fire the alarm** | Live ETH scored 0–21 throughout development. Real crashes are rare — that is the point of the product, and also why a recorded crash is needed to demonstrate it. |
|  **Single oracle** | One address feeds the data: a single point of trust and failure. Partly mitigated — the contract computes the regime itself rather than trusting a posted verdict, and data older than 2 minutes cannot authorise an alarm. |
|  **The "normal" window is self-poisoning** | Normality is measured over a rolling 4 hours. A crash lasting longer than that becomes its own normal, and the score decays while the market is still broken. The forecaster partly compensates; the three lights do not. |
| 🟡 **The three lights overlap** | This minute's fall is also one of the 30 minutes used to measure shaking. So lights 1 and 2 share information — 50 % + 35 % is not 85 % of *independent* evidence. |
|  **Saturation** | Anything beyond 3 z-scores reads 100. The score cannot tell "bad" from "1929". |
|  **Testnet only, unaudited** | 27 custody tests, no audit. **Do not put real money in it.** |

---

#  Roadmap

1. **Execution event streams** — subscribe directly from the node, removing polling entirely
2. **Decentralised oracle set** — several independent observers, contract takes the median.
   The model is deterministic, so honest observers agree bit-for-bit — which is
   exactly why the inference had to be on-chain
3. **Multi-asset** — one model per market, running in parallel
4. **More warning lights** — a gas-price factor and a news factor were designed and
   deliberately cut as too fragile to build in a day
5. **Memory for the three lights** — fire at 70 but only stand down below 50, giving
   the fixed formula the stickiness the forecaster has, with no training at all

---

# Appendix A — The formal mathematics

*Everything above, written precisely. Nothing here is new — this is the same
system stated in symbols instead of words. Variable meanings are in
[the table above](#the-variables-one-line-each).*

## A.1 — The Redline Score

For each one-minute bar *t*, with close price $P$ (USDT) and base volume $V$ (ETH):

**Step 1 — Log return.** The price change, written so that gains and losses are
symmetric and additive across bars.

$$r_t = \ln\!\left(\frac{P_t}{P_{t-1}}\right)$$

**Step 2 — Rolling volatility.** The sample standard deviation of the last 30
returns. Units are *per minute*; annualised for display as
$\sigma\sqrt{525{,}600}$, since crypto trades 24/7 and a year is 525,600 minutes.

$$\sigma_t = \mathrm{stdev}\left(r_{t-29},\ \ldots,\ r_t\right)$$

**Step 3 — Volume shock.** A dimensionless ratio against the recent mean.

$$VS_t = V_t \Big/ \mathrm{mean}\left(V_{t-29},\ \ldots,\ V_t\right)$$

**Step 4 — Standardise** against a rolling 240-bar (4-hour) baseline. Note the
negation on the return: a large *fall* gives a large *positive* $z^r$, so the
score is one-sided and does not fire on rallies.

$$z^{\sigma}_t = \frac{\sigma_t - \mu_{240}(\sigma)}{s_{240}(\sigma)}
\qquad
z^{r}_t = \frac{(-r_t) - \mu_{240}(-r)}{s_{240}(-r)}$$

**Step 5 — Map to 0–100, clamped at both ends.** Clamping is why a calm market
reads 0 rather than a negative number.

$$C_\sigma = 100\cdot\mathrm{clip}\!\left(\tfrac{z^\sigma}{3},0,1\right)
\qquad
C_r = 100\cdot\mathrm{clip}\!\left(\tfrac{z^r}{3},0,1\right)
\qquad
C_v = 100\cdot\mathrm{clip}\!\left(\tfrac{VS-1}{3},0,1\right)$$

**Step 6 — Weighted sum.** The weights sum to 1, so $S \in [0,100]$ **by
construction**, not by clipping the output. Alarm threshold: **70**.

$$S_t = 0.50\,C_\sigma \;+\; 0.35\,C_r \;+\; 0.15\,C_v$$

### Worked example — the worst minute of the crash

| Factor | Actual reading | Z-score | 0–100 | × Weight | = Points |
|---|---|---:|---:|---:|---:|
| Volatility, 30-bar σ | 0.429 %/min · 311 % annualised | +2.97 | 99.01 | 0.50 | 49.50 |
| Downside, 1-bar log return | −1.528 % | +4.63 | 100.00 | 0.35 | 35.00 |
| Volume shock vs 30-bar mean | 15,303 ETH · 3.54× normal | — | 84.81 | 0.15 | 12.72 |
| | | | | **TOTAL** | **97.23** |

The three point values add to the score exactly. There is no hidden term.

## A.2 — The regime filter (runs on-chain)

A two-state Gaussian Hidden Markov Model. Returns are assumed drawn from one of
two hidden regimes — *calm* (0) or *turbulent* (1) — each Gaussian with its own
mean $\mu$ and standard deviation $\sigma$, with the hidden state following a
Markov chain with transition probabilities $a_{ij}$.

The model splits along its own mathematics, and that split is the core
architectural decision:

| | Cost | Determinism | Where it runs |
|---|---|---|---|
| **Training** — Baum–Welch / EM | Expensive | Non-deterministic (local optima) | **Off-chain, once** |
| **Inference** — forward filter | O(K²) per bar | Exactly deterministic | **On-chain, every bar** |

**Predict.** Mix the previous belief through the transition matrix. Linear, exact
in fixed point.

$$p^-_t = a_{01} + p_{t-1}\,(a_{11} - a_{01})$$

**Log-likelihood ratio.** How much more consistent this observation is with
turbulence than with calm. The $1/\sqrt{2\pi}$ is common to both states and
cancels; $\ln(\sigma_0/\sigma_1)$ is a stored constant.

$$d_t = \ln\frac{\sigma_0}{\sigma_1}
\;+\; \frac{(r_t-\mu_0)^2}{2\sigma_0^2}
\;-\; \frac{(r_t-\mu_1)^2}{2\sigma_1^2}$$

**Update.** Bayes' rule, divided through by the calm likelihood so that only the
ratio $L = e^{d}$ is needed. **One exponential per bar** — that is the entire
on-chain cost. Alarm threshold: $p \ge 0.80$.

$$p_t = \frac{p^-_t\,e^{d_t}}{p^-_t\,e^{d_t} + \left(1 - p^-_t\right)}$$

> **Two properties worth noting.** Because $0 < a_{01}$ and $a_{11} < 1$, the
> predict step guarantees $p^- \in (0,1)$ — the filter is *self-healing*, can never
> lock at certainty, and the update denominator can never be zero. And $d$ needs
> clamping only at ±40, which is harmless because $p$ has saturated long before.

### Fitted parameters

Trained on bars 1–14,864 (2022-05-01 00:01 → 2022-05-11 07:44 UTC), ending
1,000 bars before the demo window.

| Parameter | Value | Meaning |
|---|---:|---|
| $\sigma_0$ | 0.001258 | calm regime — 0.1258 %/min |
| $\sigma_1$ | 0.004695 | turbulent regime — 0.4695 %/min |
| $\sigma_1/\sigma_0$ | **3.73×** | the two states are cleanly separated |
| $a_{01}$ | 0.003910 | P(calm → turbulent) per minute |
| $a_{11}$ | 0.938167 | P(turbulent → turbulent) |
| $1/(1-a_{11})$ | **16.2 bars** | expected length of a turbulent run |
| $p_0$ | 0.059476 | stationary prior |

### Out-of-sample result

On the 240 bars the model never saw during training:

```
P(turbulent) min 0.0017   max 1.0000
bars above 0.80: 106 / 240
first crossing of 0.80 at bar 16
```

## A.3 — The custody invariant

Enforced by `withdraw()` draining the bunker first and `redline()` accumulating
rather than assigning. Verified under every ordering of deposit / alarm / reset /
withdraw by Test 2.

$$\texttt{vaultBalance} + \texttt{bunkerBalance} \;=\; \sum_{u} \texttt{userBalances}[u]$$

---

<div align="center">

### Built in one day at Monad London Blitz, 8 August 2026
by two first-time hackathon participants sharing one laptop.

*The Redline Score — its factors, weights and thresholds — was designed and
calibrated by hand. The rails, the contract and the on-chain model were built with
Claude Code.*


<sub>Licensed MIT. `RegimeVault.sol` vendors `exp2` from [PRBMath](https://github.com/PaulRBerg/prb-math) (MIT).</sub>

</div>

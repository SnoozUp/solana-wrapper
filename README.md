# Solana Subscription Platform

The on-chain program is an Anchor smart contract on Solana that manages one challenge account (a PDA) per challenge ID. The account is created at a fixed size, so it never needs to grow. Funds are SOL (lamports) held in the state account. The state stores the fee, commission percent, status, primary owner, a small list of additional owners, the subscriber list, the winner list, and a simple counter that increments on admin actions.

The flow: initialize creates the state PDA. subscribe transfers the fee from the user to the state and records the subscriber. set_winners_list records the winners. set_status changes the status explicitly. send_bonus_to_winners calculates available balance above rent, takes commission, splits the rest equally to winners, sends leftovers to the treasury, and marks the challenge closed. refund_batch sends the fee back to the given subscribers and removes them. withdraw_funds lets the OWNER take any SOL above rent.

It mirrors the Solidity: a pool of money, commission, equal winner payouts, and the remainder goes to the treasury. Differences: ERC-20/allowance on EVM vs native SOL on Solana; on-chain "view" functions on EVM vs RPC reads on Solana; gas vs a simple on-chain counter for display.

The wrapper is a small NestJS service that exposes HTTP endpoints, encodes Anchor instructions using the IDL, signs admin transactions with the owner key from environment variables, builds a subscribe transaction for the user to sign, and reads/decodes state. It has no database, no user auth, and no business logic. It's Solana-only and uses SystemProgram transfers.

## Structure

```
src/
├── main.ts                    # nestjs bootstrap with security headers
├── app.module.ts              # module config
├── controllers/
│   ├── api.controller.ts      # all the api endpoints
│   └── health.controller.ts   # health check
├── solana/
│   └── solana.service.ts      # core solana stuff
├── common/errors/
│   └── app-error.ts          # error handling
└── idl/
    └── snzup_subscription.json # anchor IDL for encoding instructions

programs/
└── snzup_subscription/
    ├── Cargo.toml
    └── src/
        ├── lib.rs            # main smart contract
        ├── contexts.rs       # account validation  
        └── internal.rs       # helper functions
```

## Setup

### 0) Install Prerequisites (once)

- **Node 18+** - Check: `node -v`, `npm -v`
- **Solana CLI** - Windows installer - Check: `solana --version`
- **Anchor** (if deploying/upgrading the program) - Check: `anchor --version`
- **Wallet keypairs** per network:
  - `.\secrets\owner-devnet.json`
  - `.\secrets\owner-mainnet.json`
  
  Both must be 64-number JSON format (ed25519 secret).

### 1) Pick Cluster + Set Solana CLI

**For Devnet:**
```bash
solana config set --url https://api.devnet.solana.com
solana config set --keypair $PWD\secrets\owner-devnet.json
solana balance
# If balance ~0, fund it:
solana airdrop 2
```

**For Mainnet:**
```bash
solana config set --url https://api.mainnet-beta.solana.com
solana config set --keypair $PWD\secrets\owner-mainnet.json
solana balance
# (No airdrop on mainnet; fund from an exchange/wallet)
```

### 2) Program IDs (one per cluster)

Use the Program ID deployed for each network:
- **DEVNET PROGRAM_ID** = devnet PID
- **MAINNET PROGRAM_ID** = mainnet PID

Check they exist:
```bash
solana program show <DEVNET_PID> --url https://api.devnet.solana.com
solana program show <MAINNET_PID> --url https://api.mainnet-beta.solana.com
```

Keep the same PID. Upgrade authority must match the wallet you set in solana config.

### 3) Environment Files (we can have two files)

**`.env.mainnet` (example):**
```env
NODE_ENV=production
HOST=0.0.0.0
PORT=3001

SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
PROGRAM_ID=Mainnet ProgramID
TREASURY_PUBKEY= MAINNET TREASURY
STATE_MAX_SIZE=3793
PRIORITY_MICROLAMPORTS=0

ADMIN_TOKEN=prod-admin-token
READ_TTL_MS=2000
BLOCKHASH_TTL_MS=2000
RPC_MAX_CONCURRENCY=6
BUILD_MAX_CONCURRENCY=4

SOLANA_OWNER_SECRET_KEY_FILE=.\secrets\owner-mainnet.json
CORS_ORIGIN=*
```

### 4) Install + Run Wrapper (devnet or mainnet)

From the project root in PowerShell:

```bash
npm install
npm run build

# For devnet
npm start

Open Swagger: http://localhost:3001/docs

## Api Endpoints 

## Admin (owner wallet)

- `POST /api/initialize/ChallengeID` - initialize the state PDA  
  *Create the challenge PDA and set first values.*  
  Req: { "challengeId": "123", "fee": "100000000", "commission": 10 }  
  Res: { "signature": "5KJp7...", "state": "7xKs9..." }  
  

- `POST /api/winners/ChallengeID` - set winners list  
  *Set or replace the winners for the current challenge.*  
  Req: { "winners": ["9WzDXw...WWM", "2xNweL...a8i"] }  
  Res: { "signature": "3Hj8k..." }  
  Errors: 400 empty/invalid pubkeys

- `POST /api/send-bonus-to-winner/ChallengeID` - distribute pot and close  
  *Pay winners, send commission to treasury, mark status CLOSED.*  
  Req: {}  
  Res: { "signature": "8Nm2p..." }  
  Errors: 404 winners not set / 500 insufficient funds


- `POST /api/set-fee` - update fee  
  *Set the subscription fee (lamports).*  
  Req: { "fee": "200000000" }  
  Res: { "signature": "7Rs4t..." }  
  Errors: 400 invalid fee


- `POST /api/cancel-subscription/ChallengeID` - cancel & refund one user  
  *Cancel a single subscriber and refund their fee.*  
  Req: { "subscriber": "9WzDXw...WWM" }  
  Res: { "signature": "2Bc8d..." }  
  Errors: —

---

## 👤 User

- `POST /api/build/subscribe-tx` - build unsigned subscribe tx  
  *Build a transaction for the user to sign in their wallet.*  
  Req: { "subscriber": "9WzDXw...WWM" }  
  Res: { "txBase64": "AQAAAA...==", "message": "User must sign this transaction and submit via sendTransaction" }  
  Errors: —

- `POST /api/subscribe` - deprecated  
  *Deprecated: returns 501, use /api/build/subscribe-tx.*  
  Req: {}  
  Res: { "code": "NOT_IMPLEMENTED", "message": "Use /api/build/subscribe-tx; user must sign" }  
  Errors: —

---

## 📖 Read

- `GET /api/state` - read full state  
  *Return the complete PDA state for the current challenge.*  
  Req: —  
  Res: { "pda": "7xKs9BdX...", "version": 1, "bump": 254, "owner": "9WzDXw...WWM", "challengeId": "123", "fee": "100000000", "commission": 10, "status": 1, "opCounter": "5", "owners": ["9WzDXw...WWM"], "subscribers": ["2xNweL...a8i","3yOwfM...b9j"], "winnersList": ["2xNweL...a8i"], "subscribersCount": 2 }  
  Errors: 404 state not found

- `GET /api/fee` - read fee  
  *Return current subscription fee (lamports).*  
  Req: —  
  Res: { "fee": "100000000" }  
  Errors: —

- `GET /api/commission` - read commission  
  *Return commission percent.*  
  Req: —  
  Res: { "commission": 10 }  
  Errors: —

- `GET /api/status` - read status  
  *Return challenge status code.*  
  Req: —  
  Res: { "status": 1 }  
  Errors: —

- `GET /api/challenge-id` - read challenge id  
  *Return current challengeId.*  
  Req: —  
  Res: { "challengeId": "123" }  
  Errors: —

- `GET /api/winners` - read winners  
  *Return winners list.*  
  Req: —  
  Res: { "winners": ["2xNweL...a8i","3yOwfM...b9j"] }  
  Errors: —

- `GET /api/op-counter` - read op counter  
  *Return operation counter.*  
  Req: —  
  Res: { "opCounter": "5" }  
  Errors: —

- `GET /api/events/:signature` - read events by tx  
  *Return emitted events for a given transaction signature.*  
  Req: signature in path  
  Res: { "signature": "5KJp7...", "events": [ { "name": "SubscriberAdded", "data": { "subscriber": "9WzDXw...WWM", "fee": "100000000" } } ] }  
  Errors: —


- `At runtime:`

user wants in → wrapper builds subscribe ix (payer = user), wallet signs, program pulls fee into PDA + appends user

admin closes → wrapper calls set_winners_list, then send_bonus_to_winners, program splits available lamports, pays winners + treasury, flips paid, locks status to CLOSED

refunds path is there too (refund_batch) with remaining_accounts alignment 



- `keep these the same during upgrades:`

RPC/cluster (devnet with devnet, mainnet with mainnet)

Program ID (upgrade the same one)

declare_id!(...) in Rust, the Anchor.toml mapping, and wrapper .env PROGRAM_ID (all aligned)

PDA seeds ("state", owner, challengeId_le)

STATE_MAX_SIZE=3793 in wrapper env matching on-chain layout size

CHALLENGE_ID parity: wrapper env CHALLENGE_ID == body.challengeId on initialize (wrapper enforces it)

we don’t redeploy a new program for every challenge...the program is one thing with one Program ID, the data for each challenge lives in its own PDA account. seeds are "state" + ownerPubkey + challengeId(le).

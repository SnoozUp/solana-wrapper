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

1. Install stuff:
   ```bash
   npm install
   ```

2. Copy the env file:
   ```bash
   cp .env.example .env
   ```
   
   Need to set:
   - `SOLANA_RPC_URL` - solana RPC endpoint
   - `PROGRAM_ID` - smart contract program ID (set for devnet)
   - `CHALLENGE_ID` - challenge identifier
   - `SOLANA_OWNER_SECRET_KEY` - service wallet secret key array
   - `TREASURY_PUBKEY` - treasury wallet address for commission

3. Run it:
   ```bash
   npm run build
   npm start
   ```

## Api Endpoints 

## 🔧 Admin (owner wallet)

- `POST /api/initialize` - initialize the state PDA  
  *Create the challenge PDA and set first values.*  
  Req: { "challengeId": "123", "fee": "100000000", "commission": 10 }  
  Res: { "signature": "5KJp7...", "state": "7xKs9..." }  
  Errors: 400 bad input / 409 already exists

- `POST /api/winners` - set winners list  
  *Set or replace the winners for the current challenge.*  
  Req: { "winners": ["9WzDXw...WWM", "2xNweL...a8i"] }  
  Res: { "signature": "3Hj8k..." }  
  Errors: 400 empty/invalid pubkeys

- `POST /api/send-bonus-to-winners` - distribute pot and close  
  *Pay winners, send commission to treasury, mark status CLOSED.*  
  Req: {}  
  Res: { "signature": "8Nm2p..." }  
  Errors: 404 winners not set / 500 insufficient funds

- `POST /api/refund-batch` - refund subscribers  
  *Return the fee to the specified subscribers and remove them from the list.*  
  Req: { "subscribers": ["9WzDXw...WWM", "2xNweL...a8i"] }  
  Res: { "signature": "4Kl9m..." }  
  Errors: 400 empty subscribers / 404 subscriber not found

- `POST /api/withdraw-funds` - withdraw surplus SOL  
  *Withdraw any SOL above rent-exempt minimum to owner wallet.*  
  Req: {}  
  Res: { "signature": "6Pq3r..." }  
  Errors: —

- `POST /api/set-fee` - update fee  
  *Set the subscription fee (lamports).*  
  Req: { "fee": "200000000" }  
  Res: { "signature": "7Rs4t..." }  
  Errors: 400 invalid fee

- `POST /api/set-commission` - update commission  
  *Set commission percent (0–100).*  
  Req: { "commissionPercentage": 15 }  
  Res: { "signature": "8Tu5v..." }  
  Errors: 400 out of range

- `POST /api/set-owner` - change owner  
  *Set a new primary owner pubkey.*  
  Req: { "newOwner": "9WzDXw...WWM" }  
  Res: { "signature": "9Wx6y..." }  
  Errors: —

- `POST /api/set-status` - update status  
  *Force challenge status (0=pending,1=in-progress,2=closed,3=canceled).*  
  Req: { "status": 1 }  
  Res: { "signature": "1Az7b..." }  
  Errors: —

- `POST /api/cancel-subscription` - cancel & refund one user  
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


## Testing with Backend

1. Start the wrapper on a port:
   ```bash
   PORT=3001 npm start
   ```

2. Test reading (no wallet needed):
   ```bash
   curl http://localhost:3001/api/state
   curl http://localhost:3001/api/fee
   ```

3. Test user subscription flow:
   ```bash
   #  S1: Backend calls build/subscribe-tx
   curl -X POST http://localhost:3001/api/build/subscribe-tx \
     -H "Content-Type: application/json" \
     -d '{"subscriber": "USER_WALLET_PUBKEY"}'
   
   #  S2: Client signs the returned txBase64 with wallet and submits via sendTransaction
   #  S3: Check subscriber was added
   curl http://localhost:3001/api/state | jq '.subscribers'
   ```

4. Test admin operations:
   ```bash
   curl -X POST http://localhost:3001/api/send-bonus-to-winners
   curl http://localhost:3001/api/set-fee \
     -H "Content-Type: application/json" \
     -d '{"fee": "100000000"}'
   ```

5. Check operation counter:
   ```bash
   curl http://localhost:3001/api/op-counter
   ```

## Backend Setup

```bash
SOLANA_RPC_URL=https://api.devnet.solana.com
PROGRAM_ID=AKMoTiFexNvW3efoiwDcemdraDrnhzfBqTeTL21fVRB9
CHALLENGE_ID=1
SOLANA_OWNER_SECRET_KEY=
TREASURY_PUBKEY=
```

Create wallet:
```bash
solana-keygen new --outfile ~/.config/solana/backend-service.json
cat ~/.config/solana/backend-service.json
---


# Deploy Wrapper

### 1.1 Clone Repository
```bash
git clone <your-repo-url>
cd solanascfinal
```

### 1.2 Install Dependencies
```bash
npm install
```

### 1.3 Create Service Wallet
```bash
# Generate new keypair for the wrapper service
solana-keygen new --outfile service-wallet.json

# View the secret key array
cat service-wallet.json
```

### 1.4 Configure Environment
```bash
# Copy environment template
cp .env.example .env

# Edit .env with your values:
nano .env
```

Required values in `.env`:
```bash
SOLANA_RPC_URL=https://api.devnet.solana.com
PROGRAM_ID=AKMoTiFexNvW3efoiwDcemdraDrnhzfBqTeTL21fVRB9
CHALLENGE_ID=1
SOLANA_OWNER_SECRET_KEY=[1,2,3,4,5,...]  # Array from service-wallet.json
TREASURY_PUBKEY=YourTreasuryWalletPublicKey
```

### 1.5 Fund Service Wallet
```bash
# Get wallet address
solana-keygen pubkey service-wallet.json

# Fund with devnet SOL (for transaction fees)
solana airdrop 2 <wallet-address> --url devnet
```

### 1.6 Start Wrapper
```bash
# Build and start
npm run build
npm start

# Should output: "Server running on http://127.0.0.1:3001"
```

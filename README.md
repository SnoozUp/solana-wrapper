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
   
   You need to set:
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

### Read operations (no wallet needed)

- `GET /api/state` - complete contract state (PDA, owners, subscribers, winners)
- `GET /api/fee` - subscription fee in lamports
- `GET /api/commission` - commission percentage
- `GET /api/status` - contract status
- `GET /api/challenge-id` - current challenge ID
- `GET /api/winners` - winners list
- `GET /api/events/:signature` - get events by transaction signature
- `GET /api/op-counter` - operation counter
- `GET /health` - health check (no /api prefix)
- `GET /ready` - readiness check (no /api prefix)

### Admin operations (need owner wallet)
- `POST /api/initialize` - initialize the state PDA
- `POST /api/winners` - set winners list
- `POST /api/send-bonus-to-winners` - distribute bonuses to winners, take commission, close challenge
- `POST /api/distribute` - alias for send-bonus-to-winners
- `POST /api/refund-batch` - refund subscribers
- `POST /api/refund` - alias for refund-batch
- `POST /api/withdraw-funds` - withdraw SOL above rent to the owner
- `POST /api/set-fee` - update subscription fee
- `POST /api/set-commission` - update commission percentage
- `POST /api/set-status` - update contract status
- `POST /api/set-owner` - set new owner
- `POST /api/remove-owner` - remove owner
- `POST /api/cancel-subscription` - cancel user subscription

### User operations
- `POST /api/build/subscribe-tx` - build subscribe transaction for user to sign
- `POST /api/subscribe` - returns 501 error, use build/subscribe-tx instead

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

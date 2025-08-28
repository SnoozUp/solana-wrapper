import { Injectable, Logger, HttpException, OnModuleDestroy } from '@nestjs/common';
import { Connection, PublicKey, Keypair, SystemProgram, AccountMeta, TransactionInstruction, Transaction, ComputeBudgetProgram } from '@solana/web3.js';
import { BorshInstructionCoder, BorshAccountsCoder } from '@coral-xyz/anchor';
import BN from 'bn.js';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

// Load IDL
const idlPath = path.resolve(__dirname, '../idl/snzup_subscription.json');
const idl = JSON.parse(fs.readFileSync(idlPath, 'utf8'));

// BN & PK helpers
const MAX_U64 = new BN('18446744073709551615');
function toU64BN(x: string | number | bigint | BN): BN {
  if (BN.isBN(x as any)) return x as BN;
  if (typeof x === 'bigint') return new BN(x.toString(), 10);
  if (typeof x === 'number') {
    if (!Number.isFinite(x) || x < 0) throw new Error('u64 must be non-negative');
    if (x > Number.MAX_SAFE_INTEGER) throw new Error(`u64 number ${x} exceeds MAX_SAFE_INTEGER, use string`);
    return new BN(x.toString(), 10);
  }
  if (typeof x === 'string') {
    const s = x.trim().replace(/_/g, '');
    if (!/^[0-9]+$/.test(s)) throw new Error('u64 must be a base-10 integer string');
    const bn = new BN(s, 10);
    if (bn.isNeg() || bn.gt(MAX_U64)) throw new Error('u64 out of range');
    return bn;
  }
  throw new Error('u64 must be string|number|bigint|BN');
}
function toU8Number(x: string | number | bigint): number {
  const n = Number(x);
  if (!Number.isFinite(n) || n < 0 || n > 255) throw new Error(`u8 out of range: ${x}`);
  return n | 0;
}
function toPubkey(x: string | PublicKey): PublicKey {
  return x instanceof PublicKey ? x : new PublicKey(x);
}

// Discriminator + safe header decode for State
const STATE_DISC = crypto.createHash('sha256').update('account:State').digest().subarray(0, 8);
function readU64LE(buf: Buffer, o: number) { return { v: new BN(buf.subarray(o, o + 8), 'le'), o: o + 8 }; }
function readPk(buf: Buffer, o: number) { return { v: new PublicKey(buf.subarray(o, o + 32)), o: o + 32 }; }
function readVecPkSafe(buf: Buffer, o: number) {
  const len = buf.readUInt32LE(o); o += 4;
  const max = Math.floor((buf.length - o) / 32);
  if (len < 0 || len > max) throw new Error(`Bad Vec<Pubkey> length: ${len} (max ${max})`);
  const out = new Array<PublicKey>(len);
  for (let i = 0; i < len; i++) { out[i] = new PublicKey(buf.subarray(o, o + 32)); o += 32; }
  return { v: out, o };
}
type StateHeader = {
  version: number;
  bump: number;
  challengeId: BN;
  fee: BN;
  commission: number;
  status: number;
  owner: PublicKey;
  opCounter: BN;
  vecOffset: number;
};
const STATE_MAX_SIZE = 3760; // Fixed size for rent floor calculation
function decodeStateHeader(data: Buffer): StateHeader {
  if (data.length < 8 + 1 + 1 + 8 + 8 + 1 + 1 + 32 + 8) throw new Error('State too small');
  if (!data.subarray(0, 8).equals(STATE_DISC)) throw new Error('Invalid State discriminator');
  let o = 8;
  const version = data.readUInt8(o); o += 1;
  const bump = data.readUInt8(o); o += 1;
  const challengeId = new BN(data.readBigUInt64LE(o).toString()); o += 8;
  const fee = new BN(data.readBigUInt64LE(o).toString()); o += 8;
  const commission = data.readUInt8(o); o += 1;
  const status = data.readUInt8(o); o += 1;
  const owner = new PublicKey(data.subarray(o, o + 32)); o += 32;
  const opCounter = new BN(data.readBigUInt64LE(o).toString()); o += 8;
  return { version, bump, challengeId, fee, commission, status, owner, opCounter, vecOffset: o };
}

class ServerWallet {
  constructor(public payer: Keypair) {}
  get publicKey() { return this.payer.publicKey; }
}

@Injectable()
export class SolanaService implements OnModuleDestroy {
  private readonly logger = new Logger(SolanaService.name);
  private connection: Connection;
  private wallet: ServerWallet;
  private programId: PublicKey;
  private ixCoder: BorshInstructionCoder;
  private accountCoder: BorshAccountsCoder;


  constructor() {
    const rpc = process.env.SOLANA_RPC_URL;
    const programIdStr = process.env.PROGRAM_ID;
    const challengeIdStr = process.env.CHALLENGE_ID;
    const secretKey = process.env.SOLANA_OWNER_SECRET_KEY;

    if (!rpc) this.fail(503, 'SOLANA_RPC_URL_MISSING', 'SOLANA_RPC_URL env is required');
    if (!programIdStr) this.fail(503, 'PROGRAM_ID_MISSING', 'PROGRAM_ID env is required');
    if (!challengeIdStr) this.fail(503, 'CHALLENGE_ID_MISSING', 'CHALLENGE_ID env is required');
    if (!secretKey) this.fail(503, 'SOLANA_OWNER_SECRET_KEY_MISSING', 'SOLANA_OWNER_SECRET_KEY env is required');

    let keypairData: number[];
    try {
      keypairData = secretKey.startsWith('[') && secretKey.endsWith(']')
        ? JSON.parse(secretKey)
        : JSON.parse(fs.readFileSync(secretKey, 'utf8'));
    } catch (e: any) {
      this.fail(503, 'INVALID_SECRET_KEY_FORMAT', `Invalid SOLANA_OWNER_SECRET_KEY format: ${e?.message || e}`);
    }

    const ownerKeypair = Keypair.fromSecretKey(Uint8Array.from(keypairData!));
    this.wallet = new ServerWallet(ownerKeypair);
    this.connection = new Connection(rpc, 'confirmed');
    this.programId = new PublicKey(programIdStr);
    this.ixCoder = new BorshInstructionCoder(idl);
    this.accountCoder = new BorshAccountsCoder(idl);

    const idlProgram = idl?.metadata?.address || idl?.address;
    if (idlProgram && idlProgram !== this.programId.toBase58()) {
      this.fail(503, 'IDL_PROGRAM_MISMATCH', `IDL program ID (${idlProgram}) != PROGRAM_ID (${this.programId.toBase58()})`);
    }

    this.logger.log(`Solana ready @ ${rpc} | Program=${this.programId.toBase58()}`);
  }

  onModuleDestroy(): void {
    try { (this.connection as any)?._rpcWebSocket?.close?.(); } catch {}
  }

  // PDA: ["state", owner, challenge_id_le]
  private deriveStatePda(owner: PublicKey, challengeId: bigint | number): PublicKey {
    const buf = Buffer.alloc(8); buf.writeBigUInt64LE(BigInt(challengeId));
    const [pda] = PublicKey.findProgramAddressSync([Buffer.from('state'), owner.toBuffer(), buf], this.programId);
    return pda;
  }
  private statePda(): PublicKey {
    return this.deriveStatePda(this.wallet.publicKey, BigInt(process.env.CHALLENGE_ID!));
  }

  private async rpc<T>(label: string, fn: () => Promise<T>, attempts = 3): Promise<T> {
    let last: any;
    for (let i = 0; i < attempts; i++) {
      try { return await fn(); }
      catch (e: any) {
        last = e;
        const msg = String(e?.message || '');
        const transient = /429|Too Many|ECONNRESET|ETIMEDOUT|network|Blockhash/i.test(msg);
        if (!transient || i === attempts - 1) break;
        await new Promise(r => setTimeout(r, 200 * (i + 1) + Math.random() * 200));
      }
    }
    throw last;
  }

  private async rentFloorLamports(): Promise<number> {
    return this.connection.getMinimumBalanceForRentExemption(STATE_MAX_SIZE);
  }

  private fail(status: number, code: string, message: string, details?: any): never {
    const error = { status, code, message, details, ts: new Date().toISOString() };
    this.logger.error(`${code}: ${message}${details ? ` | ${JSON.stringify(details)}` : ''}`);
    throw new HttpException(error, status);
  }

  private async getAccountData(pda: PublicKey): Promise<Buffer> {
    const info = await this.rpc('getAccountInfo', () => this.connection.getAccountInfo(pda, 'confirmed'));
    if (!info) this.fail(404, 'STATE_NOT_FOUND', `State ${pda.toBase58()} not found`);
    if (!info.owner.equals(this.programId)) this.fail(422, 'INVALID_ACCOUNT_OWNER', `Owner ${info.owner.toBase58()} != ${this.programId.toBase58()}`);
    return info.data;
  }

  private async getStateHeaderAndPda(): Promise<{ pda: PublicKey; hdr: StateHeader }> {
    const pda = this.statePda();
    const data = await this.getAccountData(pda);
    const hdr = decodeStateHeader(data);
    return { pda, hdr };
  }

  private safeDecodeVectors(data: Buffer, vecOffset: number) {
    try {
      let o = vecOffset;
      const v1 = readVecPkSafe(data, o); const owners = v1.v; o = v1.o;
      const v2 = readVecPkSafe(data, o); const subscribers = v2.v; o = v2.o;
      const v3 = readVecPkSafe(data, o); const winnersList = v3.v;
      return { owners, subscribers, winnersList };
    } catch (e: any) {
      this.logger.warn(`Vector decode failed: ${e?.message || e}. Using empty arrays.`);
      return { owners: [], subscribers: [], winnersList: [] };
    }
  }

  // READ APIs
  async getState() {
    const pda = this.statePda();
    try {
      const accountInfo = await this.connection.getAccountInfo(pda);
      if (!accountInfo) this.fail(404, 'STATE_NOT_FOUND', `State ${pda.toBase58()} not found`);
      
      // Try safe manual decoding first to avoid memory issues
      try {
        const hdr = decodeStateHeader(accountInfo.data);
        const vecs = this.safeDecodeVectors(accountInfo.data, hdr.vecOffset);
        
        return {
          pda: pda.toBase58(),
          version: hdr.version,
          bump: hdr.bump,
          owner: hdr.owner.toBase58(),
          challengeId: hdr.challengeId.toString(),
          fee: hdr.fee.toString(),
          commission: hdr.commission,
          status: hdr.status,
          opCounter: hdr.opCounter.toString(),
          owners: vecs.owners.map(x => x.toBase58()),
          subscribers: vecs.subscribers.map(x => x.toBase58()),
          winnersList: vecs.winnersList.map(x => x.toBase58()),
          subscribersCount: vecs.subscribers.length,
        };
      } catch (manualError) {
        this.logger.warn(`Manual decode failed: ${(manualError as Error).message}, trying Anchor decode`);
        // Only try Anchor as fallback if manual fails
        const state = this.accountCoder.decode('state', accountInfo.data);
        
        return {
          pda: pda.toBase58(),
          version: state.version,
          bump: state.bump,
          owner: state.owner.toBase58(),
          challengeId: state.challengeId.toString(),
          fee: state.fee.toString(),
          commission: state.commission,
          status: state.status,
          opCounter: state.opCounter?.toString() || '0',
          owners: state.owners.map((x: PublicKey) => x.toBase58()),
          subscribers: state.subscribers.map((x: PublicKey) => x.toBase58()),
          winnersList: state.winnersList.map((x: PublicKey) => x.toBase58()),
          subscribersCount: state.subscribers.length,
        };
      }
    } catch (e: any) {
      this.fail(422, 'DECODE_ERROR', `Failed to decode state: ${e.message}`);
    }
  }

  async getFee() { 
    const { pda, hdr } = await this.getStateHeaderAndPda();
    return { fee: hdr.fee.toString() }; 
  }
  async getCommission() { 
    const { pda, hdr } = await this.getStateHeaderAndPda();
    return { commission: hdr.commission }; 
  }
  async getStatus() { 
    const { pda, hdr } = await this.getStateHeaderAndPda();
    return { status: hdr.status }; 
  }
  async getChallengeId() { 
    const { pda, hdr } = await this.getStateHeaderAndPda();
    return { challengeId: hdr.challengeId.toString() }; 
  }

  async getOperationFee() {
    const { pda, hdr } = await this.getStateHeaderAndPda();
    // Return opCounter directly without calling smart contract
    // The smart contract getOperationFee() only emits an event, doesn't return data
    return { opCounter: hdr.opCounter.toString() };
  }


  // TX helper
  private async sendIx(ixName: string, accounts: AccountMeta[], args: any): Promise<string> {
    const data = this.ixCoder.encode(ixName, args);
    const ix = new TransactionInstruction({ programId: this.programId, keys: accounts, data });

    const tx = new Transaction();

    // Priority fee (optional)
    const microLamports = Number(process.env.PRIORITY_MICROLAMPORTS || 0);
    if (Number.isFinite(microLamports) && microLamports > 0) {
      tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports }));
    }

    // Compute budget: 200k is enough for your flows; adjust if needed.
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));

    tx.add(ix);
    tx.feePayer = this.wallet.publicKey;

    for (let attempt = 0; attempt < 3; attempt++) {
      const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash('confirmed');
      tx.recentBlockhash = blockhash;
      tx.sign(this.wallet.payer);

      try {
        const sig = await this.connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
        await this.connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
        return sig;
      } catch (e: any) {
        const msg = String(e?.message || '');
        const expired = /blockhash.*expired|Blockhash not found/i.test(msg);
        if (!expired || attempt === 2) {
          throw new HttpException({ status: 400, code: 'PROGRAM_ERROR', message: msg }, 400);
        }
        // loop to refresh blockhash and retry
      }
    }

    throw new HttpException({ status: 400, code: 'PROGRAM_ERROR', message: 'Retries exhausted' }, 400);
  }

  // WRITE APIs 

  // initialize(challengeId, fee, commission) — accounts: state, owner(signer,payer), systemProgram
  async initialize(body: { challengeId: string|number|bigint; fee: string|number|bigint; commission: string|number|bigint; }) {
    const challengeId = toU64BN(body.challengeId);
    const fee = toU64BN(body.fee);
    const commission = toU8Number(body.commission);
    if (commission > 100) this.fail(400, 'BAD_INPUT', 'commission must be 0–100');

    const pda = this.deriveStatePda(this.wallet.publicKey, BigInt(challengeId.toString()));
    const exists = await this.connection.getAccountInfo(pda, 'confirmed');
    if (exists) return { alreadyInitialized: true, state: pda.toBase58() };

    const keys: AccountMeta[] = [
      { pubkey: pda, isSigner: false, isWritable: true },                  // state
      { pubkey: this.wallet.publicKey, isSigner: true, isWritable: true }, // owner/payer
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ];
    const signature = await this.sendIx('initialize', keys, { challengeId, fee, commission });
    return { signature, state: pda.toBase58() };
  }

  // subscribe() — accounts: state, subscriber(signer,payer), systemProgram
  async subscribe() {
    // Return 501 - clients should use buildSubscribeTx instead
    this.fail(501, 'USE_BUILD_TX', 'Use /api/build/subscribe-tx to get unsigned transaction for client-side signing');
  }

  async buildSubscribeTx(body: { subscriber: string }) {
    const pda = this.statePda();
    const subscriber = toPubkey(body.subscriber);

    const keys: AccountMeta[] = [
      { pubkey: pda, isSigner: false, isWritable: true },
      { pubkey: subscriber, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ];

    const data = this.ixCoder.encode('subscribe', {});
    const ix = new TransactionInstruction({ programId: this.programId, keys, data });

    const tx = new Transaction().add(ix);
    const { blockhash } = await this.connection.getLatestBlockhash('finalized');
    tx.recentBlockhash = blockhash;
    tx.feePayer = subscriber; // client pays

    // IMPORTANT: do not sign; the client must sign
    const txBase64 = tx.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    }).toString('base64');

    return { txBase64 };
  }


  // setWinnersList(winners) — accounts: state, owner(signer)
  async setWinnersList(body: { winners: string[] }) {
    const pda = this.statePda();
    const winners = body.winners.map(toPubkey);
    const keys: AccountMeta[] = [
      { pubkey: pda, isSigner: false, isWritable: true },
      { pubkey: this.wallet.publicKey, isSigner: true, isWritable: false },
    ];
    const signature = await this.sendIx('setWinnersList', keys, { winners });
    return { signature };
  }

  // sendBonusToWinners(snoozupWallet) — accounts:
  // state, owner(signer), treasuryWallet(SystemAccount), systemProgram
  // Remaining accounts MUST be the winners (System accounts), in same order as state.winners_list.
  async sendBonusToWinners() {
    const treasuryStr = (process.env.TREASURY_PUBKEY || '').trim();
    if (!treasuryStr) this.fail(500, 'TREASURY_PUBKEY_MISSING', 'Set TREASURY_PUBKEY env');
    const treasury = new PublicKey(treasuryStr);

    const { pda, hdr } = await this.getStateHeaderAndPda();
    const full = await this.getAccountData(pda);
    const { winnersList } = this.safeDecodeVectors(full, hdr.vecOffset);

    // Account metas limit protection
    const MAX_TX_ACCOUNTS = 64;
    const BASE_KEYS = 4;
    const maxWinnersInOneTx = MAX_TX_ACCOUNTS - BASE_KEYS;
    if (winnersList.length > maxWinnersInOneTx) {
      this.fail(
        422,
        'TOO_MANY_WINNERS_FOR_SINGLE_TX',
        `Winners=${winnersList.length} exceed per-tx account limit (~${maxWinnersInOneTx}). Reduce winners or change on-chain instruction to support batching.`
      );
    }

    // Remove early return for zero winners - let program handle distribution to treasury

    // Check contract balance before attempting distribution
    const accountInfo = await this.connection.getAccountInfo(pda);
    if (!accountInfo) this.fail(404, 'STATE_NOT_FOUND', 'State account not found');
    
    const minBalance = await this.rentFloorLamports();
    const availableBalance = accountInfo.lamports - minBalance;
    
    if (availableBalance <= 0) {
      return { 
        signature: null, 
        message: 'Insufficient contract balance for distribution',
        availableBalance: availableBalance.toString()
      };
    }

    const base: AccountMeta[] = [
      { pubkey: pda, isSigner: false, isWritable: true },
      { pubkey: this.wallet.publicKey, isSigner: true, isWritable: false },
      { pubkey: treasury, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ];
    const remaining = winnersList.map(w => ({ pubkey: w, isSigner: false, isWritable: true } as AccountMeta));

    try {
      const signature = await this.sendIx('sendBonusToWinners', [...base, ...remaining], { snoozupWallet: treasury });
      return { signature, winners: winnersList.map(w => w.toBase58()) };
    } catch (e: any) {
      if (e.message?.includes('InsufficientContractBalance')) {
        return { 
          signature: null, 
          message: 'Contract has insufficient balance for bonus distribution. Need subscribers to pay fees first.',
          error: 'INSUFFICIENT_BALANCE',
          winners: winnersList.map(w => w.toBase58())
        };
      }
      throw e;
    }
  }

  // refundBatch(subscribers) — accounts:
  // state, owner(signer), systemProgram
  async refundBatch(body: { subscribers: string[] }) {
    const pda = this.statePda();
    const subs = body.subscribers.map(toPubkey);
    
    // Check if there are any subscribers to refund
    if (subs.length === 0) {
      return { signature: null, message: 'No subscribers to refund' };
    }
    
    // Check contract balance before attempting refund
    const accountInfo = await this.connection.getAccountInfo(pda);
    if (!accountInfo) this.fail(404, 'STATE_NOT_FOUND', 'State account not found');
    
    const minBalance = await this.rentFloorLamports();
    const availableBalance = accountInfo.lamports - minBalance;
    
    if (availableBalance <= 0) {
      return { 
        signature: null, 
        message: 'Insufficient contract balance for refunds',
        availableBalance: availableBalance.toString()
      };
    }
    
    const base: AccountMeta[] = [
      { pubkey: pda, isSigner: false, isWritable: true },
      { pubkey: this.wallet.publicKey, isSigner: true, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ];
    const remaining = subs.map(s => ({ pubkey: s, isSigner: false, isWritable: true } as AccountMeta));
    
    try {
      const signature = await this.sendIx('refundBatch', [...base, ...remaining], { subscribers: subs });
      return { signature };
    } catch (e: any) {
      if (e.message?.includes('InsufficientContractBalance')) {
        return { 
          signature: null, 
          message: 'Contract has insufficient balance for refunds. Need subscribers to pay fees first.',
          error: 'INSUFFICIENT_BALANCE'
        };
      }
      throw e;
    }
  }

  // withdrawFunds() — accounts: state, owner(signer), systemProgram
  async withdrawFunds() {
    const pda = this.statePda();
    
    // Check contract balance before attempting withdrawal
    try {
      const accountInfo = await this.connection.getAccountInfo(pda);
      if (!accountInfo) this.fail(404, 'STATE_NOT_FOUND', 'State account not found');
      
      const minBalance = await this.rentFloorLamports();
      const availableBalance = accountInfo.lamports - minBalance;
      
      if (availableBalance <= 0) {
        return { 
          signature: null, 
          message: 'No funds available for withdrawal. Contract only has rent-exempt minimum.',
          availableBalance: availableBalance.toString(),
          totalBalance: accountInfo.lamports.toString(),
          minRentBalance: minBalance.toString()
        };
      }
    } catch (e: any) {
      this.logger.warn(`Balance check failed: ${e.message}`);
    }
    
    const keys: AccountMeta[] = [
      { pubkey: pda, isSigner: false, isWritable: true },
      { pubkey: this.wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ];
    
    try {
      const signature = await this.sendIx('withdrawFunds', keys, {});
      return { signature };
    } catch (e: any) {
      if (e.message?.includes('InsufficientContractBalance') || e.message?.includes('insufficient')) {
        return { 
          signature: null, 
          message: 'No withdrawable funds. Contract needs subscriber fees to accumulate balance.',
          error: 'INSUFFICIENT_BALANCE'
        };
      }
      throw e;
    }
  }

  // setFee(u64) — accounts: state, owner(signer)
  async setFee(body: { fee: string | number }) {
    const pda = this.statePda();
    const keys: AccountMeta[] = [
      { pubkey: pda, isSigner: false, isWritable: true },
      { pubkey: this.wallet.publicKey, isSigner: true, isWritable: false },
    ];
    const signature = await this.sendIx('setFee', keys, { fee: toU64BN(body.fee) });
    return { signature };
  }

  // setCommision(u8) — accounts: state, owner(signer) (typo preserved)
  async setCommision(body: { commissionPercentage: string | number }) {
    const pda = this.statePda();
    const keys: AccountMeta[] = [
      { pubkey: pda, isSigner: false, isWritable: true },
      { pubkey: this.wallet.publicKey, isSigner: true, isWritable: false },
    ];
    const signature = await this.sendIx('setCommision', keys, { commissionPercentage: toU8Number(body.commissionPercentage) });
    return { signature };
  }

  // setOwner(newOwner) — accounts: state, owner(signer)
  async setOwner(body: { newOwner: string }) {
    const pda = this.statePda();
    const keys: AccountMeta[] = [
      { pubkey: pda, isSigner: false, isWritable: true },
      { pubkey: this.wallet.publicKey, isSigner: true, isWritable: false },
    ];
    const signature = await this.sendIx('setOwner', keys, { newOwner: toPubkey(body.newOwner) });
    return { signature };
  }

  // removeOwner(user) — accounts: state, owner(signer)
  async removeOwner(body: { user: string }) {
    const pda = this.statePda();
    const keys: AccountMeta[] = [
      { pubkey: pda, isSigner: false, isWritable: true },
      { pubkey: this.wallet.publicKey, isSigner: true, isWritable: false },
    ];
    const signature = await this.sendIx('removeOwner', keys, { user: toPubkey(body.user) });
    return { signature };
  }

  // setStatus(u8) — accounts: state, owner(signer)
  async setStatus(body: { status: number }) {
    const pda = this.statePda();
    const keys: AccountMeta[] = [
      { pubkey: pda, isSigner: false, isWritable: true },
      { pubkey: this.wallet.publicKey, isSigner: true, isWritable: false },
    ];
    const signature = await this.sendIx('setStatus', keys, { status: toU8Number(body.status) });
    return { signature };
  }

  // cancelSubscription(subscriber) — accounts: state, owner(signer)
  async cancelSubscription(body: { subscriber: string }) {
    const pda = this.statePda();
    const keys: AccountMeta[] = [
      { pubkey: pda, isSigner: false, isWritable: true },
      { pubkey: this.wallet.publicKey, isSigner: true, isWritable: false },
    ];
    const signature = await this.sendIx('cancelSubscription', keys, { subscriber: toPubkey(body.subscriber) });
    return { signature };
  }


  async health() {
    return { ok: true, backend: false };
  }

  async events(signature: string) {
    try {
      const tx = await this.connection.getTransaction(signature, { commitment: 'confirmed' });
      if (!tx) return { error: 'Transaction not found' };
      
      // Simple log message return - structured event parsing needs full anchor program context
      return { events: tx.meta?.logMessages || [] };
    } catch (e: any) {
      return { error: e.message };
    }
  }

  async getWinners() {
    const state = await this.getState();
    return { winners: state.winnersList };
  }

  async ready() {
    try {
      const pda = this.statePda();
      const rpcOk = await this.connection.getLatestBlockhash().then(() => true).catch(() => false);
      const stateExists = await this.connection.getAccountInfo(pda).then(info => !!info).catch(() => false);
      
      return {
        rpc: rpcOk,
        programLoaded: true,
        stateExists,
        backend: false
      };
    } catch {
      return {
        rpc: false,
        programLoaded: false,
        stateExists: false,
        backend: false
      };
    }
  }
}

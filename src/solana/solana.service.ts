// src/solana/solana.service.ts
// Import all the tools we need for the Solana blockchain
import { Injectable, Logger, HttpException } from '@nestjs/common';
import { Connection, PublicKey, Keypair, TransactionInstruction, TransactionMessage, VersionedTransaction, AccountMeta, SystemProgram, Transaction, ComputeBudgetProgram } from '@solana/web3.js';
import BN from 'bn.js';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { RpcGate, Gate } from './rpc-gate';
import { BlockhashMgr } from './blockhash';
import { MicroCache } from './micro-cache';
import { RateLimiter } from './rate-limiter';

// Identify different types of blockchain operations
//The SC has discriminator to identify which function to call
//SC receives a transaction -> if the instruction matches SUBSCRIBE_DISK -> executes subscribe()
const ixDisc = (name: string) =>
  crypto.createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
const STATE_DISC = crypto
  .createHash('sha256')
  .update('account:State')
  .digest()
  .subarray(0, 8);

// Pre-made ID codes for common operations
const SUBSCRIBE_DISC = crypto
  .createHash('sha256')
  .update('global:subscribe')
  .digest()
  .subarray(0, 8);

// Helper functions 
const MAX_U64 = new BN('18446744073709551615');

// Convert different number types to the format Solana understands
function toU64BN(x: string | number | bigint | BN): BN {
  if (BN.isBN(x as any)) return x as BN;
  if (typeof x === 'bigint') return new BN(x.toString(), 10);
  if (typeof x === 'number') {
    if (!Number.isFinite(x) || x < 0) throw new Error('u64 must be non-negative');
    if (x > Number.MAX_SAFE_INTEGER)
      throw new Error(`u64 number ${x} exceeds MAX_SAFE_INTEGER, use string`);
    return new BN(x.toString(), 10);
  }
  const str = String(x);
  const bn = new BN(str, 10);
  if (bn.isNeg()) throw new Error('u64 must be non-negative');
  if (bn.gt(MAX_U64)) throw new Error('u64 overflow');
  return bn;
}

// Convert to small number (0-255) for things like percentages
function toU8Number(x: string | number | bigint): number {
  const n = Number(x);
  if (!Number.isFinite(n) || n < 0 || n > 255) throw new Error(`u8 out of range: ${x}`);
  return n | 0;
}

// Convert string addresses to Solana public key format
function toPubkey(x: string | PublicKey): PublicKey {
  return x instanceof PublicKey ? x : new PublicKey(x);
}

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
  treasury: PublicKey;
  paid: boolean;
  opCounter: BN;
  vecOffset: number;
};

// Matches on-chain constants -from evm 
const STATE_MAX_SIZE = Number(process.env.STATE_MAX_SIZE ?? 3793);

// State decode
function readU64BN(buf: Buffer, o: number) {
  return { v: new BN(buf.subarray(o, o + 8), 'le'), o: o + 8 };
}

// Header decoder: scalars first sequentially, then vectors
function decodeStateHeader(data: Buffer): StateHeader {
  if (data.length < 8 + 93) throw new Error('State too small');

  const disc = data.subarray(0, 8);
  if (!disc.equals(STATE_DISC)) {
    throw new Error('Invalid State discriminator');
  }

  let o = 8;
  const version = data.readUInt8(o); o += 1;
  const bump    = data.readUInt8(o); o += 1;

  let r = readU64BN(data, o); const challengeId = r.v; o = r.o;
  r = readU64BN(data, o);     const fee         = r.v; o = r.o;

  const commission = data.readUInt8(o); o += 1;
  const status     = data.readUInt8(o); o += 1;

  const owner    = new PublicKey(data.subarray(o, o + 32)); o += 32;
  const treasury = new PublicKey(data.subarray(o, o + 32)); o += 32;

  const paid = data.readUInt8(o) !== 0; o += 1;

  r = readU64BN(data, o); const opCounter = r.v; o = r.o;

  const vecOffset = o; // 8 + 93 = 101
  return { version, bump, challengeId, fee, commission, status, owner, treasury, paid, opCounter, vecOffset };
}

class ServerWallet {
  constructor(public payer: Keypair) {}
  get publicKey() { return this.payer.publicKey; }
}

// This is the main service that talks to the Solana blockchain
@Injectable()
export class SolanaService {
  private readonly logger = new Logger(SolanaService.name);
  private readonly connection: Connection; // Connection to Solana network
  private readonly programId: PublicKey; // Smart contract address
  private readonly wallet: ServerWallet; // Our wallet for signing transactions
  private readonly cache = new MicroCache(Number(process.env.READ_TTL_MS ?? 2000)); // Cache to make things faster
  private readonly rpcGate = new RpcGate(10); // RPC connection manager (max 10 concurrent)
  private readonly rateLimiter = new RateLimiter(
    Number(process.env.RPC_RATE_LIMIT_TOKENS ?? 100), 
    Number(process.env.RPC_RATE_LIMIT_REFILL ?? 10)
  ); // Rate limiter to avoid overwhelming RPC (100 tokens, refills at 10/sec)
  private readonly distributionGate = new Gate(1); // Only allow 1 prize distribution at a time
  private readonly buildGate = new Gate(Number(process.env.BUILD_MAX_CONCURRENCY ?? 4)); // Build-only gate
  private readonly blockhashMgr = new BlockhashMgr(); // Blockhash cache manager
  private readonly bh = this.blockhashMgr; // Shorthand for blockhash manager
  private readonly idempotencyCache = new Map<string, { result: any; timestamp: number }>(); // Cache for preventing duplicate operations
  private idempoSweeper?: NodeJS.Timeout; // Handle for cleanup interval

  // Set up the service when it starts
  constructor() {
    const rpc = process.env.SOLANA_RPC_URL;
    const programIdStr = process.env.PROGRAM_ID;
    const secretKeyPath = process.env.SOLANA_OWNER_SECRET_KEY_FILE;
    const treasuryPubkeyStr = process.env.TREASURY_PUBKEY;

    if (!rpc) this.fail(503, 'SOLANA_RPC_URL_MISSING', 'SOLANA_RPC_URL env is required');
    if (!programIdStr) this.fail(503, 'PROGRAM_ID_MISSING', 'PROGRAM_ID env is required');
    if (!secretKeyPath) this.fail(503, 'SECRET_KEY_FILE_MISSING', 'SOLANA_OWNER_SECRET_KEY_FILE env is required (path to secret key file)');
    if (!treasuryPubkeyStr || treasuryPubkeyStr === '11111111111111111111111111111111' ||
        treasuryPubkeyStr === SystemProgram.programId.toBase58()) {
      this.fail(503, 'TREASURY_PUBKEY_INVALID', 'TREASURY_PUBKEY env is invalid or not set');
    }

    let keypairData: number[];
    try {
      if (!fs.existsSync(secretKeyPath)) {
        this.fail(503, 'SECRET_KEY_FILE_NOT_FOUND', `Secret key file not found: ${secretKeyPath}`);
      }
      const fileContent = fs.readFileSync(secretKeyPath, 'utf8').trim();
      keypairData = JSON.parse(fileContent);
      if (!Array.isArray(keypairData) || keypairData.length !== 64) {
        throw new Error('Secret key must be array of 64 numbers');
      }
    } catch (e: any) {
      this.fail(503, 'INVALID_SECRET_KEY_FORMAT', `Invalid secret key file format: ${e?.message || e}`);
    }

    const ownerKeypair = Keypair.fromSecretKey(Uint8Array.from(keypairData!));
    this.wallet = new ServerWallet(ownerKeypair);
    this.connection = new Connection(rpc, 'confirmed');
    this.programId = new PublicKey(programIdStr);
    this.logger.log(`Solana ready @ ${rpc} | Program=${this.programId.toBase58()} | STATE_MAX_SIZE=${STATE_MAX_SIZE} | SecretKey loaded from file`);
    this.logger.warn('🚀Secret key loaded from file - ensure file permissions are 600 (owner read-only)');
    
    // Check for dangerous fallback flags in production
    const isProd = process.env.NODE_ENV === 'production';
    if (isProd) {
      if (process.env.ALLOW_RENT_FALLBACK === '1') {
        this.logger.error('SECURITY WARNING: ALLOW_RENT_FALLBACK is enabled in production! This should NEVER happen.');
        throw new Error('ALLOW_RENT_FALLBACK must be disabled in production');
      }
      if (process.env.ALLOW_VECTOR_DECODE_SOFTFAIL === '1') {
        this.logger.error('SECURITY WARNING: ALLOW_VECTOR_DECODE_SOFTFAIL is enabled in production! This can mask data corruption.');
        throw new Error('ALLOW_VECTOR_DECODE_SOFTFAIL must be disabled in production');
      }
    } else {
      // Warn in non-production if flags are set
      if (process.env.ALLOW_RENT_FALLBACK === '1') {
        this.logger.warn('ALLOW_RENT_FALLBACK is enabled. Using hardcoded rent values if RPC fails.');
      }
      if (process.env.ALLOW_VECTOR_DECODE_SOFTFAIL === '1') {
        this.logger.warn('ALLOW_VECTOR_DECODE_SOFTFAIL is enabled. Will return empty arrays on decode failures.');
      }
    }
    
    // leaning up old idempotency entries periodically
    this.idempoSweeper = setInterval(() => {
      const cutoff = Date.now() - 10 * 60 * 1000;
      const toDelete: string[] = [];
      for (const [k, v] of this.idempotencyCache) {
        if (v.timestamp < cutoff) toDelete.push(k);
      }
      toDelete.forEach(k => this.idempotencyCache.delete(k));
    }, 60_000);
    this.idempoSweeper.unref?.();
  }

  onModuleDestroy(): void {
    try { this.idempoSweeper && clearInterval(this.idempoSweeper); } catch {}
    try { (this.connection as any)?._rpcWebSocket?.close?.(); } catch {}
  }

  // PDA: ["state", owner, challenge_id_le]
  private deriveStatePda(owner: PublicKey, challengeId: bigint | number): PublicKey {
    const buf = Buffer.alloc(8); buf.writeBigUInt64LE(BigInt(challengeId));
    const [pda] = PublicKey.findProgramAddressSync([Buffer.from('state'), owner.toBuffer(), buf], this.programId);
    return pda;
  }

  // Helper to pick owner from string or default to wallet
  private pickOwner(ownerStr?: string): PublicKey {
    if (!ownerStr) {
      this.logger.warn('No x-owner header provided, using wrapper wallet as owner. This may indicate integration issues.');
    }
    return ownerStr ? new PublicKey(ownerStr) : this.wallet.publicKey;
  }

  // Derive PDA with explicit owner and challenge ID
  private statePdaFor(owner: PublicKey, challengeId: string): PublicKey {
    if (!challengeId) this.fail(400, 'BAD_INPUT', 'challengeId required');
    return this.deriveStatePda(owner, BigInt(challengeId));
  }


  private async rpc<T>(name: string, fn: () => Promise<T>, attempts = 3): Promise<T> {
    // Wait for rate limiter token before calling RPC
    await this.rateLimiter.acquire();
    
    return this.rpcGate.run(async () => {
      let last: any;
      for (let i = 0; i < attempts; i++) {
        try { return await fn(); }
        catch (e: any) {
          last = e;
          const msg = String(e?.message || '');
          const transient = /429|Too Many|ECONNRESET|ETIMEDOUT|Blockhash|rate/i.test(msg);
          if (!transient || i === attempts - 1) break;
          // tiny jitter backoff
          await new Promise(r => setTimeout(r, 150 * (i + 1) + Math.random() * 150));
        }
      }
      throw last;
    });
  }

  // Calculate how much SOL we need to keep the account alive on Solana - The rent concept in solana
  private rentFloorLamportsCache?: number;
  private async rentFloorLamports(): Promise<number> {
    // Compute once via RPC and cache; fallback to conservative constant
    if (typeof this.rentFloorLamportsCache === 'number' && Number.isFinite(this.rentFloorLamportsCache)) {
      return this.rentFloorLamportsCache;
    }
    try {
      const v = await this.rpc<number>('getMinimumBalanceForRentExemption', () =>
        this.connection.getMinimumBalanceForRentExemption(STATE_MAX_SIZE as number)
      );
      this.rentFloorLamportsCache = v;
      return v;
    } catch (e) {
      //Safety fallback mode - use hardcoded value if RPC fails
      if (process.env.ALLOW_RENT_FALLBACK !== '1') {
        this.fail(503, 'RENT_QUERY_FAILED', 'getMinimumBalanceForRentExemption failed');
      }
      // Pre-calculated rent exemption for STATE_MAX_SIZE=3793 bytes (fallback mode)
      // NOTE: This value may become stale if Solana changes rent calculations
      this.logger.error('FALLBACK MODE: Using hardcoded rent value due to RPC failure. Verify this is expected!');
      this.rentFloorLamportsCache = 27290160;
      return this.rentFloorLamportsCache;
    }
  }

  private fail(status: number, code: string, message: string, details?: any): never {
    const error = { 
      source: 'wrapper', 
      category: 'validation', 
      code, 
      message, 
      details, 
      retriable: false, 
      ts: new Date().toISOString() 
    };
    this.logger.error(`${code}: ${message}${details ? ` | ${JSON.stringify(details)}` : ''}`);
    throw new HttpException(error, status);
  }


  private invalidateStateCacheForChallenge(challengeId: string, owner?: PublicKey) {
    const o = owner ?? this.wallet.publicKey;
    const key = 'state:' + this.statePdaFor(o, challengeId).toBase58();
    this.cache.del(key);
  }

  private checkIdempotency(key: string): any | null {
    if (!key || key.trim().length === 0) return null;
    
    const cached = this.idempotencyCache.get(key);
    if (!cached) return null;
    
    // 10 minute TTL
    if (Date.now() - cached.timestamp > 10 * 60 * 1000) {
      this.idempotencyCache.delete(key);
      this.logger.warn(`Idempotency key expired and removed: ${key}`);
      return null;
    }
    
    this.logger.log(`Returning cached result for idempotency key: ${key}`);
    return cached.result;
  }

  // Remember results so we don't do the same operation twice by accident
  private cacheIdempotencyResult(key: string, result: any) {
    if (!key) return;
    
    // Keep cache under 10k entries to prevent memory leak
    const MAX_CACHE_SIZE = 10000;
    
    // Evict oldest 20% if we hit the limit
    if (this.idempotencyCache.size >= MAX_CACHE_SIZE) {
      const toRemove = Math.floor(MAX_CACHE_SIZE * 0.2);
      this.logger.warn(`Idempotency cache at limit (${this.idempotencyCache.size}), evicting ${toRemove} oldest entries`);
      
      // Remove oldest entries first
      const entries = Array.from(this.idempotencyCache.entries())
        .sort((a, b) => a[1].timestamp - b[1].timestamp);
      
      for (let i = 0; i < toRemove && i < entries.length; i++) {
        this.idempotencyCache.delete(entries[i][0]);
      }
    }
    
    this.idempotencyCache.set(key, { result, timestamp: Date.now() });
    
    // Clean up old entries (older than 10 minutes)
    if (this.idempotencyCache.size > 1000) {
      const cutoff = Date.now() - 10 * 60 * 1000;
      const toDelete: string[] = [];
      for (const [k, v] of this.idempotencyCache) {
        if (v.timestamp < cutoff) toDelete.push(k);
      }
      if (toDelete.length > 0) {
        toDelete.forEach(k => this.idempotencyCache.delete(k));
        this.logger.log(`Cleaned up ${toDelete.length} expired idempotency entries`);
      }
    }
  }

  // Test a transaction before sending it to see if it will work
  private async simulate(ix: TransactionInstruction, payer: PublicKey, skipSigVerify = false) {
    const { blockhash } = await this.rpc('getLatestBlockhash', () => this.connection.getLatestBlockhash('processed'));
    const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: [ix] }).compileToV0Message();
    const vtx = new VersionedTransaction(msg);
    
    // Skip signature verification for simulation only
    const sim = await this.rpc('simulateTransaction', () => 
      this.connection.simulateTransaction(vtx, { 
        sigVerify: skipSigVerify,
        commitment: 'processed'
      })
    );
    
    return {
      logs: sim.value?.logs || [],
      error: sim.value?.err,
      unitsConsumed: sim.value?.unitsConsumed || 0
    };
  }

  private async withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
    let lastErr: any;
    for (let i = 0; i < 3; i++) {
      try {
        return await fn();
      } catch (e: any) {
        const msg = String(e?.message || '');
        const transient = /429|Too Many|Blockhash|rate|ECONNRESET|ETIMEDOUT|timeout|expired/i.test(msg);
        if (!transient || i === 2) throw e;
        
        // Exponential backoff with jitter
        const delay = 200 * (i + 1) + Math.random() * 200;
        this.logger.warn(`${label} failed (attempt ${i + 1}/3), retrying in ${delay}ms: ${msg}`);
        await new Promise(resolve => setTimeout(resolve, delay));
        lastErr = e;
      }
    }
    throw lastErr;
  }

  private async getAccountData(pda: PublicKey): Promise<Buffer> {
    const info = await this.rpc('getAccountInfo', () => this.connection.getAccountInfo(pda, 'confirmed'));
    if (!info) this.fail(404, 'STATE_NOT_FOUND', `State ${pda.toBase58()} not found`);
    if (!info.owner.equals(this.programId))
      this.fail(422, 'INVALID_ACCOUNT_OWNER', `Owner ${info.owner.toBase58()} != ${this.programId.toBase58()}`);
    return info.data;
  }


  // Read vectors sequentially (owners → subscribers → winners)
  private safeDecodeVectors(data: Buffer, vecOffset: number): { owners: PublicKey[]; subscribers: PublicKey[]; winnersList: PublicKey[] } {
    try {
      let o = vecOffset;
      const r1 = readVecPkSafe(data, o); const owners = r1.v; o = r1.o;
      const r2 = readVecPkSafe(data, o); const subscribers = r2.v; o = r2.o;
      const r3 = readVecPkSafe(data, o); const winnersList = r3.v;
      
      // Decoder sanity check: warn if vectors are empty but state suggests otherwise
      return { owners, subscribers, winnersList };
    } catch (e) {
      //
      // Soft-fail mode for vector decode errors (for development/testing only)
      if (process.env.ALLOW_VECTOR_DECODE_SOFTFAIL === '1') {
        this.logger.error(`SOFT-FAIL MODE: Vector decode failed: ${e?.message || e}. Using empty arrays. THIS SHOULD NOT HAPPEN IN PRODUCTION!`);
        return { owners: [], subscribers: [], winnersList: [] };
      } else {
        this.fail(422, 'DECODE_VECTORS_FAILED', `Vector decode failed: ${String(e)}`);
      }
    }
  }


  // IX data builder
  private buildIxData(ixName: string, args: any): Buffer {
    switch (ixName) {
      case 'initialize': { // (challenge_id: u64, fee: u64, commission: u8, treasury: Pubkey)
        const d = ixDisc('initialize');
        const b = Buffer.alloc(8 + 8 + 8 + 1 + 32);
        d.copy(b, 0);
        b.writeBigUInt64LE(BigInt(toU64BN(args.challengeId).toString()), 8);
        b.writeBigUInt64LE(BigInt(toU64BN(args.fee).toString()), 16);
        b.writeUInt8(toU8Number(args.commission), 24);
        toPubkey(args.treasury).toBuffer().copy(b, 25);
        return b;
      }
      case 'set_fee': { // (fee: u64)
        const d = ixDisc('set_fee');
        const b = Buffer.alloc(8 + 8);
        d.copy(b, 0);
        b.writeBigUInt64LE(BigInt(toU64BN(args.fee).toString()), 8);
        return b;
      }
      case 'set_commision': { // (commission_percentage: u8)  // on-chain misspelling(from EVM)
        const d = ixDisc('set_commision');
        const b = Buffer.alloc(8 + 1);
        d.copy(b, 0);
        b.writeUInt8(toU8Number(args.commissionPercentage), 8);
        return b;
      }
      case 'set_owner': { // (new_owner: Pubkey)
        const d = ixDisc('set_owner');
        const b = Buffer.alloc(8 + 32);
        d.copy(b, 0);
        toPubkey(args.newOwner).toBuffer().copy(b, 8);
        return b;
      }
      case 'remove_owner': { // (user: Pubkey)
        const d = ixDisc('remove_owner');
        const b = Buffer.alloc(8 + 32);
        d.copy(b, 0);
        toPubkey(args.user).toBuffer().copy(b, 8);
        return b;
      }
      case 'set_status': { // (status: u8)
        const d = ixDisc('set_status');
        const b = Buffer.alloc(8 + 1);
        d.copy(b, 0);
        b.writeUInt8(toU8Number(args.status), 8);
        return b;
      }
      case 'cancel_subscription': { // (subscriber: Pubkey)
        const d = ixDisc('cancel_subscription');
        const b = Buffer.alloc(8 + 32);
        d.copy(b, 0);
        toPubkey(args.subscriber).toBuffer().copy(b, 8);
        return b;
      }
      case 'set_winners_list': { // (winners: Vec<Pubkey>)
        const winners: PublicKey[] = (args.winners || []).map(toPubkey);
        const d = ixDisc('set_winners_list');
        const b = Buffer.alloc(8 + 4 + 32 * winners.length);
        d.copy(b, 0);
        b.writeUInt32LE(winners.length, 8);
        winners.forEach((pk, i) => pk.toBuffer().copy(b, 12 + i * 32));
        return b;
      }
      case 'refund_batch': { // (subscribers: Vec<Pubkey>)
        const subs: PublicKey[] = (args.subscribers || []).map(toPubkey);
        const d = ixDisc('refund_batch');
        const b = Buffer.alloc(8 + 4 + 32 * subs.length);
        d.copy(b, 0);
        b.writeUInt32LE(subs.length, 8);
        subs.forEach((pk, i) => pk.toBuffer().copy(b, 12 + i * 32));
        return b;
      }
      case 'send_bonus_to_winners': { // no args
        const d = ixDisc('send_bonus_to_winners');
        const b = Buffer.alloc(8);
        d.copy(b, 0);
        return b;
      }
      case 'subscribe': { // no args
        const d = ixDisc('subscribe');
        const b = Buffer.alloc(8);
        d.copy(b, 0);
        return b;
      }
      case 'set_treasury': { // (new_treasury: Pubkey)
        const d = ixDisc('set_treasury');
        const b = Buffer.alloc(8 + 32);
        d.copy(b, 0);
        toPubkey(args.newTreasury).toBuffer().copy(b, 8);
        return b;
      }
      default:
        throw new Error(`Unknown instruction: ${ixName}`);
    }
  }

  //  TX helper 
  private async sendIx(ixName: string, accounts: AccountMeta[], args: any): Promise<string> {
    const data = this.buildIxData(ixName, args);
    const ix = new TransactionInstruction({ programId: this.programId, keys: accounts, data });

    const raw = Number(process.env.PRIORITY_MICROLAMPORTS);
    const microLamports = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;

    for (let attempt = 0; attempt < 3; attempt++) {
      // Create fresh transaction for each attempt to avoid signature accumulation
      const txAttempt = new Transaction();
      if (microLamports > 0) {
        txAttempt.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports }));
      }
      txAttempt.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
      txAttempt.add(ix);
      txAttempt.feePayer = this.wallet.publicKey;

      const { blockhash, lastValidBlockHeight } = await this.rpc('getLatestBlockhash', () => this.connection.getLatestBlockhash('confirmed'));
      txAttempt.recentBlockhash = blockhash;
      txAttempt.sign(this.wallet.payer);

      try {
        const sig = await this.withRetry('sendRawTransaction', () => 
          this.rpc('sendRawTransaction', () => this.connection.sendRawTransaction(txAttempt.serialize(), { skipPreflight: false }))
        );
        await this.withRetry('confirmTransaction', () =>
          this.rpc('confirmTransaction', () => this.connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed'))
        );
        return sig;
      } catch (e: any) {
        const msg = String(e?.message || '');
        const expired = /blockhash.*expired|Blockhash not found/i.test(msg);
        if (!expired || attempt === 2) {
          // Add simulation for better error visibility
          const simResult = await this.simulate(ix, this.wallet.publicKey, true).catch(() => ({ logs: [], error: null, unitsConsumed: 0 }));
          throw new HttpException({
            source: 'solana',
            category: /simulate|custom program error/i.test(msg) ? 'program' : 'rpc',
            code: /custom program error: (0x[0-9a-fA-F]+)/.test(msg)
                    ? `PROGRAM_ERROR_${msg.match(/0x[0-9a-fA-F]+/)![0]}`
                    : 'PROGRAM_ERROR',
            message: msg,
            details: { logs: simResult.logs, simulationError: simResult.error, unitsConsumed: simResult.unitsConsumed },
            retriable: /429|rate limit|gateway|node is behind|BLOCKHASH/i.test(msg),
            ts: new Date().toISOString()
          }, 400);
        }
      }
    }
    throw new HttpException({ status: 400, code: 'PROGRAM_ERROR', message: 'Retries exhausted' }, 400);
  }

  // -------- MAIN FUNCTIONS FOR BACKEND TO USE ----------
  
  // Start a new challenge (like creating a new contest)
  async initialize(body: { challengeId: string|number|bigint; fee: string|number|bigint; commision: string|number|bigint; }) {
    const challengeId = toU64BN(body.challengeId);
    const fee = toU64BN(body.fee);
    const commision = toU8Number(body.commision);
    if (commision > 100) this.fail(400, 'BAD_INPUT', 'commision must be 0–100');

   
    // The challenge ID is provided via API

    const pda = this.deriveStatePda(this.wallet.publicKey, BigInt(challengeId.toString()));
    const exists = await this.rpc('getAccountInfo', () => this.connection.getAccountInfo(pda, 'confirmed'));
    if (exists) {
      // Decode existing state and compare parameters to detect mismatches
      const hdr = decodeStateHeader(exists.data);
      const mismatches = [];
      if (hdr.fee.toString() !== fee.toString()) mismatches.push(`fee: expected ${fee}, got ${hdr.fee}`);
      if (hdr.commission !== commision) mismatches.push(`commission: expected ${commision}, got ${hdr.commission}`);
      if (hdr.challengeId.toString() !== challengeId.toString()) mismatches.push(`challengeId: expected ${challengeId}, got ${hdr.challengeId}`);
      
      if (mismatches.length > 0) {
        this.fail(409, 'ALREADY_INITIALIZED_DIFFERENT_PARAMS', `Parameter mismatches: ${mismatches.join(', ')}`);
      }
      
      this.logger.warn(`Challenge ${challengeId} already initialized at ${pda.toBase58()} with matching parameters`);
      return { alreadyInitialized: true, state: pda.toBase58(), challengeId: challengeId.toString() };
    }

    const treasuryStr = (process.env.TREASURY_PUBKEY || '').trim();
    if (!treasuryStr) this.fail(500, 'TREASURY_PUBKEY_MISSING', 'Set TREASURY_PUBKEY env');
    const treasury = new PublicKey(treasuryStr);

    const keys: AccountMeta[] = [
      { pubkey: pda, isSigner: false, isWritable: true },                  // state
      { pubkey: this.wallet.publicKey, isSigner: true, isWritable: true }, // owner/payer
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ];
    const signature = await this.sendIx('initialize', keys, { challengeId, fee, commission: commision, treasury });
    this.invalidateStateCacheForChallenge(challengeId.toString());
    return { signature, state: pda.toBase58(), challengeId: challengeId.toString() };
  }

  // ============= GLOBAL METHODS WITHOUT CHALLENGE ID =============
  // These are called by controller endpoints with :challengeId in URL

  async health() {
    try {
      // Test RPC connection
      const rpcTest = await this.rpc('getLatestBlockhash', () => 
        this.connection.getLatestBlockhash('confirmed')
      ).then(() => true).catch(() => false);

      // Test program accessibility
      const programTest = await this.rpc('getAccountInfo', () =>
        this.connection.getAccountInfo(this.programId)
      ).then(info => !!info).catch(() => false);

      // State check not applicable for global health (no challenge ID context)
      const stateTest = 'N/A';

      // Test wallet accessibility
      const walletTest = await this.rpc('getAccountInfo', () =>
        this.connection.getAccountInfo(this.wallet.publicKey)
      ).then(info => !!info).catch(() => false);

      const allHealthy = rpcTest && programTest && walletTest;

      return {
        ok: allHealthy,
        backend: false,
        details: {
          rpc: rpcTest,
          program: programTest,
          state: stateTest,
          wallet: walletTest
        }
      };
    } catch (error) {
      return {
        ok: false,
        backend: false,
        error: error.message,
        details: {
          rpc: false,
          program: false,
          state: false,
          wallet: false
        }
      };
    }
  }

  async events(signature: string) {
    try {
      const tx = await this.rpc('getTransaction', () => this.connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }));
      if (!tx) return { error: 'Transaction not found' };
      return { events: tx.meta?.logMessages || [] };
    } catch (e: any) {
      return { source: 'wrapper', category: 'rpc', error: String(e?.message ?? e) };
    }
  }


  async ready() {
    const results = {
      rpc: false,
      programLoaded: false,
      stateExists: false,
      walletFunded: false,
      configValid: false,
      backend: false,
      errors: [] as string[]
    };

    try {
      // Test RPC connection with timeout
      try {
        let timeoutId: NodeJS.Timeout;
        const timeoutPromise = new Promise((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error('RPC timeout')), 5000);
        });
        await Promise.race([
          this.rpc('getLatestBlockhash', () => this.connection.getLatestBlockhash()),
          timeoutPromise
        ]);
        clearTimeout(timeoutId!);
        results.rpc = true;
      } catch (e) {
        results.errors.push(`RPC failed: ${(e as Error).message}`);
      }

      // Test program account exists
      try {
        const programInfo = await this.rpc('getAccountInfo', () => this.connection.getAccountInfo(this.programId));
        results.programLoaded = !!programInfo && programInfo.executable;
        if (!results.programLoaded) {
          results.errors.push(`Program ${this.programId.toBase58()} not found or not executable`);
        }
      } catch (e) {
        results.errors.push(`Program check failed: ${e.message}`);
      }

      // Don't force-true stateExists in global ready() - report unknown unless challengeId available
      results.stateExists = false; // Use /api/ready/:challengeId for real per-challenge state checks

      // Test wallet has sufficient balance
      try {
        const walletInfo = await this.rpc('getAccountInfo', () => this.connection.getAccountInfo(this.wallet.publicKey));
        const balance = walletInfo?.lamports || 0;
        const minBalance = 10_000_000; // 0.01 SOL minimum
        results.walletFunded = balance >= minBalance;
        if (!results.walletFunded) {
          results.errors.push(`Wallet ${this.wallet.publicKey.toBase58()} has insufficient balance: ${balance / 1e9} SOL (need ${minBalance / 1e9} SOL)`);
        }
      } catch (e) {
        results.errors.push(`Wallet check failed: ${e.message}`);
      }

      // Test configuration validity
      try {
        const treasuryPubkey = process.env.TREASURY_PUBKEY;
        const adminToken = process.env.ADMIN_TOKEN;
        
        results.configValid = !!(treasuryPubkey && adminToken);
        if (!results.configValid) {
          const missing = [];
          if (!treasuryPubkey) missing.push('TREASURY_PUBKEY');
          if (!adminToken) missing.push('ADMIN_TOKEN');
          results.errors.push(`Missing required env vars: ${missing.join(', ')}`);
        }
      } catch (e) {
        results.errors.push(`Config check failed: ${e.message}`);
      }

      const overallReady = results.rpc && results.programLoaded && results.stateExists && results.walletFunded && results.configValid;
      
      return {
        status: overallReady ? 'ready' : 'not_ready',
        ...results
      };

    } catch (error) {
      results.errors.push(`Ready check failed: ${error.message}`);
      return {
        status: 'error',
        ...results
      };
    }
  }

  // CHALLENGE ID IN URL
  // Initialize challenge with specific ID
  async initializeChallenge(challengeId: string, params: { fee: string; commision: number }) {
    // Calls the existing initialize method with the challengeId
    return this.initialize({ challengeId, fee: params.fee, commision: params.commision });
  }

  // Get state for specific challenge with optional owner override
  async getStateForChallenge(challengeId: string, ownerStr?: string) {
    const owner = this.pickOwner(ownerStr);
    const pda = this.statePdaFor(owner, challengeId);
    const key = 'state:' + pda.toBase58();
    const cached = this.cache.get<any>(key);
    if (cached) return cached;

    try {
      const accountInfo = await this.rpc('getAccountInfo', () => this.connection.getAccountInfo(pda, 'confirmed'));
      if (!accountInfo) this.fail(404, 'STATE_NOT_FOUND', `State ${pda.toBase58()} not found`);

      const hdr = decodeStateHeader(accountInfo.data);
      const vecs = this.safeDecodeVectors(accountInfo.data, hdr.vecOffset);

      const result = {
        pda: pda.toBase58(),
        version: hdr.version,
        bump: hdr.bump,
        owner: hdr.owner.toBase58(),
        treasury: hdr.treasury.toBase58(),
        paid: hdr.paid,
        challengeId: hdr.challengeId.toString(),
        fee: hdr.fee.toString(),
        commision: hdr.commission,  // Keep same key as legacy getState() for consistency
        status: hdr.status,
        opCounter: hdr.opCounter.toString(),
        owners: vecs.owners.map(x => x.toBase58()),
        subscribers: vecs.subscribers.map(x => x.toBase58()),
        winnersList: vecs.winnersList.map(x => x.toBase58()),
        subscribersCount: vecs.subscribers.length,
      };
      
      this.cache.set(key, result);
      return result;
    } catch (e: any) {
      this.fail(422, 'DECODE_ERROR', `Failed to decode state: ${e.message}`);
    }
  }

  // Build subscribe transaction for specific challenge with optional owner
  async buildSubscribeTxForChallenge(challengeId: string, params: { subscriber: string, owner?: string }) {
    return this.buildGate.run(async () => {
      // Parse subscriber (only validation as we do it with the wrapper)
      let subscriber: PublicKey;
      try { subscriber = new PublicKey(params.subscriber); }
      catch {
        throw new HttpException({
          source: 'wrapper',
          category: 'validation',
          code: 'BAD_INPUT',
          message: 'invalid subscriber pubkey',
          retriable: false
        }, 400);
      }

      // Derive PDA with specific challenge ID and owner(Getting from the main backend)
      const owner = this.pickOwner(params.owner);
      const pda = this.statePdaFor(owner, challengeId);

      // Verify state exists and is open before building tx
      const data = await this.getAccountData(pda); // throws if missing/owner mismatch
      const hdr = decodeStateHeader(data);
      if (hdr.status !== 0 /*PENDING*/) {
        this.fail(400, 'CHALLENGE_NOT_OPEN', `Challenge status=${hdr.status}, must be PENDING (0) for subscriptions`);
      }

      // One RPC
      const { blockhash, lastValidBlockHeight } = await this.bh.get(this.connection);

      // Precomputed discriminator 
      const ix = new TransactionInstruction({
        programId: this.programId,
        keys: [
          { pubkey: pda, isSigner: false, isWritable: true },
          { pubkey: subscriber, isSigner: true, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: SUBSCRIBE_DISC,
      });

      const ixs = [];
      const raw = Number(process.env.PRIORITY_MICROLAMPORTS);
      const price = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
      if (price > 0)
        ixs.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: price }));
      ixs.push(ComputeBudgetProgram.setComputeUnitLimit({ units: 180_000 }));
      ixs.push(ix);

      const msg = new TransactionMessage({
        payerKey: subscriber,
        recentBlockhash: blockhash,
        instructions: ixs,
      }).compileToV0Message();

      const vtx = new VersionedTransaction(msg);
      return {
        txBase64: Buffer.from(vtx.serialize()).toString('base64'),
        lastValidBlockHeight,
        programId: this.programId.toBase58(),
        statePda: pda.toBase58(),
        challengeId
      };
    });
  }

  // Set status for specific challenge with optional owner
  async setStatusForChallenge(challengeId: string, params: { status: number, owner?: string }) {
    const owner = this.pickOwner(params.owner);
    const pda = this.statePdaFor(owner, challengeId);
    const keys: AccountMeta[] = [
      { pubkey: pda, isSigner: false, isWritable: true },
      { pubkey: this.wallet.publicKey, isSigner: true, isWritable: false },
    ];
    const signature = await this.sendIx('set_status', keys, { status: toU8Number(params.status) });
    this.cache.del('state:' + pda.toBase58());
    return { signature, challengeId };
  }

  // Set fee for specific challenge with optional owner
  async setFeeForChallenge(challengeId: string, params: { fee: string, owner?: string }) {
    const owner = this.pickOwner(params.owner);
    const pda = this.statePdaFor(owner, challengeId);
    const keys: AccountMeta[] = [
      { pubkey: pda, isSigner: false, isWritable: true },
      { pubkey: this.wallet.publicKey, isSigner: true, isWritable: false },
    ];
    const signature = await this.sendIx('set_fee', keys, { fee: toU64BN(params.fee) });
    this.cache.del('state:' + pda.toBase58());
    return { signature, challengeId };
  }

  // Set commission for specific challenge with optional owner (note: internal uses misspelled 'set_commision')
  async setCommissionForChallenge(challengeId: string, params: { commission: number, owner?: string }) {
    const owner = this.pickOwner(params.owner);
    const pda = this.statePdaFor(owner, challengeId);
    const keys: AccountMeta[] = [
      { pubkey: pda, isSigner: false, isWritable: true },
      { pubkey: this.wallet.publicKey, isSigner: true, isWritable: false },
    ];
    // Note: on-chain instruction is misspelled as 'set_commision'
    const signature = await this.sendIx('set_commision', keys, { commissionPercentage: toU8Number(params.commission) });
    this.cache.del('state:' + pda.toBase58());
    return { signature, challengeId };
  }

  // Set winners for specific challenge with optional owner
  async setWinnersListForChallenge(challengeId: string, params: { winners: string[], owner?: string }) {
    const owner = this.pickOwner(params.owner);
    const pda = this.statePdaFor(owner, challengeId);
    const winners = params.winners.map(w => new PublicKey(w));
    
    // Winners go in instruction data, not as accounts
    const keys: AccountMeta[] = [
      { pubkey: pda, isSigner: false, isWritable: true },
      { pubkey: this.wallet.publicKey, isSigner: true, isWritable: false },
    ];
    
    const signature = await this.sendIx('set_winners_list', keys, { winners });
    this.cache.del('state:' + pda.toBase58());
    return { signature, challengeId };
  }

  // Send bonus to winners for specific challenge with owner
  async sendBonusToWinnersForChallenge(challengeId: string, ownerStr?: string) {
    return this.distributionGate.run(async () => {
      const owner = this.pickOwner(ownerStr);
      const pda = this.statePdaFor(owner, challengeId);

      // Load state & vectors
      const full = await this.getAccountData(pda);
      const hdr  = decodeStateHeader(full);
      
      // Check if already paid to prevent double payments
      if (hdr.paid) {
        this.logger.warn(`Bonus already paid for challenge ${challengeId}, PDA ${pda.toBase58()}`);
        return { 
          alreadyPaid: true, 
          message: 'Bonus distribution already completed',
          challengeId,
          pda: pda.toBase58()
        };
      }
      
      const vecs = this.safeDecodeVectors(full, hdr.vecOffset);

      if (vecs.winnersList.length === 0) {
        this.fail(400, 'NO_WINNERS', 'No winners set for this challenge');
      }

      // Guards (same as global)
      // 64-account cap: state, owner, treasury, system + winners
      const MAX_TX_ACCOUNTS = 64;
      const BASE_KEYS = 4;
      if (vecs.winnersList.length > (MAX_TX_ACCOUNTS - BASE_KEYS)) {
        this.fail(422, 'TOO_MANY_WINNERS_FOR_SINGLE_TX',
          `Winners=${vecs.winnersList.length} exceed per-tx account limit (~${MAX_TX_ACCOUNTS - BASE_KEYS}).`);
      }

      // Balance vs rent floor
      const info = await this.rpc('getAccountInfo', () => this.connection.getAccountInfo(pda));
      if (!info) this.fail(404, 'STATE_NOT_FOUND', 'State account not found');
      const minBalance = await this.rentFloorLamports();
      const availableBalance = info.lamports - minBalance;
      if (availableBalance <= 0) {
        this.fail(400, 'INSUFFICIENT_CONTRACT_BALANCE',
          `Insufficient contract balance for distribution. Available: ${availableBalance} lamports`);
      }

      // Idempotency (scoped by PDA + opCounter)
      const scope = `send_bonus:${pda.toBase58()}:${hdr.opCounter.toString()}`;
      const cached = this.checkIdempotency(scope);
      if (cached) return cached;

      const keys: AccountMeta[] = [
        { pubkey: pda, isSigner: false, isWritable: true },
        { pubkey: this.wallet.publicKey, isSigner: true, isWritable: false },
        { pubkey: hdr.treasury, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ...vecs.winnersList.map(w => ({ pubkey: w, isSigner: false, isWritable: true } as AccountMeta)),
      ];

      try {
        const signature = await this.sendIx('send_bonus_to_winners', keys, {});
        this.cache.del('state:' + pda.toBase58());
        const result = { signature, winners: vecs.winnersList.map(w => w.toBase58()), challengeId };
        this.cacheIdempotencyResult(scope, result);
        return result;
      } catch (e: any) {
        if (e.message?.includes('InsufficientContractBalance')) {
          this.fail(400, 'INSUFFICIENT_CONTRACT_BALANCE',
            'Contract has insufficient balance for bonus distribution. Need subscribers to pay fees first.');
        }
        throw e;
      }
    });
  }

  // Refund for specific challenge 
  async refundForChallenge(challengeId: string) {
    // Derive PDA for (wrapper owner, challengeId) 
    const owner = this.wallet.publicKey;
    const pda = this.statePdaFor(owner, challengeId);

    // Read subscribers from on-chain state
    const data = await this.getAccountData(pda);
    const hdr = decodeStateHeader(data);
    const vecs = this.safeDecodeVectors(data, hdr.vecOffset);
    const subs = vecs.subscribers;
    if (subs.length === 0) this.fail(400, 'NO_SUBSCRIBERS', 'No subscribers to refund');

    // Per-tx accounts & balance guards (same as refundBatch)
    const MAX_TX_ACCOUNTS = 64;
    const BASE_KEYS = 3;
    if (subs.length + BASE_KEYS > MAX_TX_ACCOUNTS) {
      this.fail(422, 'TOO_MANY_SUBSCRIBERS_FOR_SINGLE_TX', `Max ~${MAX_TX_ACCOUNTS - BASE_KEYS} subscribers per tx`);
    }

    const info = await this.rpc('getAccountInfo', () => this.connection.getAccountInfo(pda));
    if (!info) this.fail(404, 'STATE_NOT_FOUND', 'State account not found');
    const minBalance = await this.rentFloorLamports();
    const availableBalance = info.lamports - minBalance;
    if (availableBalance <= 0) {
      this.fail(400, 'INSUFFICIENT_CONTRACT_BALANCE', `Insufficient contract balance for refunds. Available: ${availableBalance} lamports`);
    }

    const base: AccountMeta[] = [
      { pubkey: pda, isSigner: false, isWritable: true },
      { pubkey: this.wallet.publicKey, isSigner: true, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ];
    const remaining = subs.map(s => ({ pubkey: s, isSigner: false, isWritable: true } as AccountMeta));

    const signature = await this.sendIx('refund_batch', [...base, ...remaining], { subscribers: subs });
    this.cache.del('state:' + pda.toBase58());
    return { signature, refunded: subs.map(s => s.toBase58()), challengeId };
  }

  // Set owner for specific challenge
  async setOwnerForChallenge(challengeId: string, params: { newOwner: string; owner?: string }) {
    const owner = this.pickOwner(params.owner);
    const pda = this.statePdaFor(owner, challengeId);
    const keys: AccountMeta[] = [
      { pubkey: pda, isSigner: false, isWritable: true },
      { pubkey: this.wallet.publicKey, isSigner: true, isWritable: false },
    ];
    const signature = await this.sendIx('set_owner', keys, { newOwner: toPubkey(params.newOwner) });
    this.cache.del('state:' + pda.toBase58());
    return { signature, challengeId };
  }

  // Remove owner for specific challenge
  async removeOwnerForChallenge(challengeId: string, params: { user: string; owner?: string }) {
    const owner = this.pickOwner(params.owner);
    const pda = this.statePdaFor(owner, challengeId);
    const keys: AccountMeta[] = [
      { pubkey: pda, isSigner: false, isWritable: true },
      { pubkey: this.wallet.publicKey, isSigner: true, isWritable: false },
    ];
    const signature = await this.sendIx('remove_owner', keys, { user: toPubkey(params.user) });
    this.cache.del('state:' + pda.toBase58());
    return { signature, challengeId };
  }

  // Cancel subscription for specific challenge
  async cancelSubscriptionForChallenge(challengeId: string, params: { subscriber: string; owner?: string }) {
    const owner = this.pickOwner(params.owner);
    const pda = this.statePdaFor(owner, challengeId);
    const subscriber = toPubkey(params.subscriber);
    const keys: AccountMeta[] = [
      { pubkey: pda, isSigner: false, isWritable: true },
      { pubkey: this.wallet.publicKey, isSigner: true, isWritable: false },
    ];
    const signature = await this.sendIx('cancel_subscription', keys, { subscriber });
    this.cache.del('state:' + pda.toBase58());
    return { signature, challengeId };
  }

  // Set treasury for specific challenge
  async setTreasuryForChallenge(challengeId: string, params: { newTreasury: string; owner?: string }) {
    const owner = this.pickOwner(params.owner);
    const pda = this.statePdaFor(owner, challengeId);
    const keys: AccountMeta[] = [
      { pubkey: pda, isSigner: false, isWritable: true },
      { pubkey: this.wallet.publicKey, isSigner: true, isWritable: false },
    ];
    const signature = await this.sendIx('set_treasury', keys, { newTreasury: toPubkey(params.newTreasury) });
    this.cache.del('state:' + pda.toBase58());
    return { signature, challengeId };
  }

  // Helper methods for health checks
  async checkRpc(): Promise<boolean> {
    try {
      await this.connection.getVersion();
      return true;
    } catch {
      return false;
    }
  }
// Check if program is deployed and executable
  async checkProgram(): Promise<boolean> {
    try {
      const accountInfo = await this.connection.getAccountInfo(this.programId);
      return accountInfo !== null && accountInfo.executable;
    } catch {
      return false;
    }
  }

  // Check if state exists for challenge - no env mutation
  async checkStateForChallenge(challengeId: string): Promise<boolean> {
    try {
      const owner = this.wallet.publicKey;
      const pda = this.statePdaFor(owner, challengeId);
      const accountInfo = await this.connection.getAccountInfo(pda);
      return accountInfo !== null;
    } catch {
      return false;
    }
  }
// Check wallet balance
  async checkWallet(): Promise<boolean> {
    try {
      const balance = await this.connection.getBalance(this.wallet.publicKey);
      return balance >= 10000000; // 0.01 SOL minimum
    } catch {
      return false;
    }
  }
// Check config validity
  checkConfig(): boolean {
    return !!(this.programId && this.wallet && process.env.TREASURY_PUBKEY);
  }
}

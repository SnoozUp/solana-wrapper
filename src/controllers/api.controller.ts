// This file handles all the web requests from your backend
import { Controller, Post, Get, Body, HttpCode, HttpException, Req, Param } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBody, ApiSecurity, ApiHeader, ApiParam } from '@nestjs/swagger';
import { Request } from 'express';
import { PublicKey } from '@solana/web3.js';
import { SolanaService } from '../solana/solana.service';
import * as crypto from 'crypto';

// This controller handles all API endpoints for the Solana wrapper
@ApiTags('solana')
@Controller('api')
export class ApiController {
  private readonly adminToken: string; // Secret password for admin operations
  private readonly isProd: boolean; // Are we running in production?

  // Set up the controller when it starts
  constructor(private readonly sol: SolanaService) {
    // Always require ADMIN_TOKEN 
    this.isProd = process.env.NODE_ENV === 'production';
    this.adminToken = process.env.ADMIN_TOKEN;
    if (!this.adminToken) {
      throw new Error('ADMIN_TOKEN environment variable is required for security');
    }
  }

  // Throw an error when the request has bad data
  private bad(field: string, msg = 'invalid'): never {
    throw new HttpException({ 
      source: 'wrapper', 
      category: 'validation', 
      code: 'BAD_INPUT', 
      field, 
      message: msg, 
      retriable: false,
      ts: new Date().toISOString()
    }, 400);
  }

  private validatePubkey(value: any, fieldName: string): string {
    if (!value || typeof value !== 'string') {
      this.bad(fieldName, 'Must be a valid base58 public key string');
    }
    if (value.length < 32 || value.length > 44) {
      this.bad(fieldName, 'Public key must be 32-44 characters (base58)');
    }
    try {
      const pubkey = new PublicKey(value);
      return pubkey.toBase58();
    } catch {
      this.bad(fieldName, 'Invalid base58 public key format');
    }
  }

  // Extract owner header from request
  private getOwnerHeader(req: Request): string | undefined {
    const raw = req.headers['x-owner'];
    return Array.isArray(raw) ? raw[0] : (raw as string | undefined);
  }

  private validateCommission(value: any): number {
    const num = Number(value);
    if (!Number.isInteger(num) || num < 0 || num > 100) {
      this.bad('commission', 'Must be integer 0-100');
    }
    return num;
  }

  private validateFee(value: any): string {
    const str = String(value);
    if (!/^\d+$/.test(str)) {
      this.bad('fee', 'Must be non-negative integer string (lamports)');
    }
    return str;
  }

  private validateStatus(value: any): number {
    const num = Number(value);
    if (!Number.isInteger(num) || num < 0 || num > 3) {
      this.bad('status', 'Must be integer 0-3 (PENDING=0, IN_PROGRESS=1, CLOSED=2, CANCELED=3)');
    }
    return num;
  }

  private validateWinners(winners: any[]): string[] {
    if (!Array.isArray(winners) || winners.length < 1 || winners.length > 10) {
      this.bad('winners', 'Must be array of 1-10 public keys');
    }
    const validated = winners.map((w, i) => this.validatePubkey(w, `winners[${i}]`));
    const unique = new Set(validated);
    if (unique.size !== validated.length) {
      this.bad('winners', 'Winners must be unique');
    }
    return validated;
  }

  private validateChallengeId(challengeId: string): string {
    if (!challengeId || challengeId.trim().length === 0) {
      this.bad('challengeId', 'challengeId required in URL');
    }
    // Validate it's a valid u64 integer string
    if (!/^\d+$/.test(challengeId)) {
      this.bad('challengeId', 'Must be a valid u64 integer string');
    }
    // Check reasonable bounds (u64 max is 18446744073709551615)
    try {
      const num = BigInt(challengeId);
      if (num < 0n) {
        this.bad('challengeId', 'Must be non-negative');
      }
    } catch {
      this.bad('challengeId', 'Invalid integer format');
    }
    return challengeId;
  }

  private checkAdmin(req: Request) {
    // Always enforce authentication regardless of environment
    const raw = req.headers['x-admin-token'];
    const token = Array.isArray(raw) ? raw[0] : raw;
    if (!token) {
      throw new HttpException({ 
        source: 'wrapper', 
        category: 'authentication', 
        code: 'FORBIDDEN', 
        message: 'Missing admin token', 
        retriable: false,
        ts: new Date().toISOString()
      }, 403);
    }
    
    // Use constant-time comparison to prevent timing attacks
    let isValid = false;
    try {
      isValid = token && this.adminToken &&
        token.length === this.adminToken.length &&
        crypto.timingSafeEqual(
          Buffer.from(token),
          Buffer.from(this.adminToken)
        );
    } catch {
      // timingSafeEqual throws if lengths don't match - treat as invalid
      isValid = false;
    }
    
    if (!isValid) {
      throw new HttpException({ 
        source: 'wrapper', 
        category: 'authentication', 
        code: 'FORBIDDEN', 
        message: 'Invalid admin token', 
        retriable: false,
        ts: new Date().toISOString()
      }, 403);
    }
  }

  // Management Endpoints

  @ApiSecurity('admin')
  @ApiOperation({ summary: 'Initialize new challenge with ID in URL' })
  @ApiParam({ name: 'challengeId', description: 'Challenge identifier', example: '123' })
  @ApiHeader({ name: 'x-admin-token', required: true, description: 'Admin token' })
  @ApiResponse({
    status: 200,
    description: 'Challenge initialized successfully',
    schema: {
      type: 'object',
      properties: {
        signature: { type: 'string', example: '4Kl9m2FtxSqX8...' },
        state: { type: 'string', example: '9WzDXwBbhgHqxw6uBHKVHvQK8196FoePKTLMS8EcnGMW' }
      }
    }
  })
  @ApiBody({ 
    schema: { 
      type: 'object', 
      required: ['fee'], 
      properties: {
        fee: { type: 'string', example: '5000000', description: 'Subscription fee in lamports' }, 
        commission: { type: 'number', example: 12, description: 'Commission percentage (0-100)' },
        commision: { type: 'number', example: 12, description: 'Legacy key; same as commission' }
      },
      anyOf: [
        { required: ['commission'] },
        { required: ['commision'] }
      ]
    } 
  })
  @Post('initialize/:challengeId')
  @HttpCode(200)
  initialize(@Param('challengeId') challengeId: string, @Body() body: any, @Req() req: Request) {
    this.checkAdmin(req);
    const id = this.validateChallengeId(challengeId);
    if (!body?.fee) this.bad('fee', 'fee required');
    if (body?.commission === undefined && body?.commision === undefined) {
      this.bad('commission', 'commission required');
    }
    
    const fee = this.validateFee(body.fee);
    // Accept both spellings for backward compatibility
    const commission = this.validateCommission(body.commission ?? body.commision);
    
    return this.sol.initializeChallenge(id, { fee, commision: commission });
  }



  // Readiness & health
  @Get('ready') 
  async ready() {
    try {
      // Simple health check
      const rpc = await this.sol.checkRpc();
      const programLoaded = await this.sol.checkProgram();
      const walletFunded = await this.sol.checkWallet();
      
      // Check env vars 
      const hasRequiredEnv = !!(
        process.env.PROGRAM_ID && 
        process.env.TREASURY_PUBKEY && 
        process.env.ADMIN_TOKEN
      );
      
      const status = rpc && programLoaded && walletFunded && hasRequiredEnv ? 'ready' : 'not_ready';
      
      return {
        status,
        rpc,
        programLoaded,
        walletFunded,
        configValid: hasRequiredEnv,
        message: 'Use GET /api/ready/:challengeId to check specific challenge state'
      };
    } catch (e) {
      return { status: 'error', message: e.message };
    }
  }
  
  @Get('health') 
  async health() {
    try {
      await this.sol.checkRpc();
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }

  @ApiOperation({ summary: 'Get transaction log events' })
  @ApiParam({ name: 'signature', description: 'Transaction signature' })
  @Get('events/:signature')
  events(@Param('signature') signature: string) {
    return this.sol.events(signature);
  }

  // CHALLENGE STATE & SUBSCRIPTION ENDPOINTS 

  @ApiOperation({ summary: 'Get state for specific challenge' })
  @ApiParam({ name: 'challengeId', description: 'Challenge identifier', example: '123' })
  @ApiHeader({ name: 'x-owner', required: false, description: 'Owner public key (optional, for multi-owner challenges)' })
  @ApiResponse({ status: 200, description: 'Challenge state (includes winnersList field)' })
  @Get('state/:challengeId')
  getStateForChallenge(@Param('challengeId') challengeId: string, @Req() req: Request) {
    const id = this.validateChallengeId(challengeId);
    const owner = this.getOwnerHeader(req);
    return this.sol.getStateForChallenge(id, owner);
  }

  @ApiOperation({ summary: 'Build subscription transaction for specific challenge' })
  @ApiParam({ name: 'challengeId', description: 'Challenge identifier', example: '123' })
  @ApiHeader({ name: 'x-owner', required: false, description: 'Owner public key (optional, for multi-owner challenges)' })
  @ApiBody({ 
    schema: { 
      type: 'object', 
      required: ['subscriber'], 
      properties: { 
        subscriber: { 
          type: 'string', 
          example: '9WzDXwBbhgHqxw6uBHKVHvQK8196FoePKTLMS8EcnGMW',
          description: 'Subscriber wallet public key' 
        } 
      } 
    } 
  })
  @Post('subscribe/:challengeId')
  @HttpCode(200)
  subscribeToChallenge(
    @Param('challengeId') challengeId: string,
    @Body() body: any,
    @Req() req: Request
  ) {
    const id = this.validateChallengeId(challengeId);
    if (!body?.subscriber || typeof body.subscriber !== 'string') this.bad('subscriber', 'subscriber (string) required');
    
    const subscriber = this.validatePubkey(body.subscriber, 'subscriber');
    const owner = this.getOwnerHeader(req);
    return this.sol.buildSubscribeTxForChallenge(id, { subscriber, owner });
  }

  @ApiSecurity('admin')
  @ApiOperation({ summary: 'Set winners for specific challenge' })
  @ApiParam({ name: 'challengeId', description: 'Challenge identifier', example: '123' })
  @ApiHeader({ name: 'x-admin-token', required: true, description: 'Admin token' })
  @ApiBody({ 
    schema: { 
      type: 'object', 
      required: ['winners'], 
      properties: { 
        winners: { type: 'array', items: { type: 'string' }, description: 'Array of winner wallet addresses' } 
      } 
    } 
  })
  @Post('winners/:challengeId')
  @HttpCode(200)
  setWinnersForChallenge(
    @Param('challengeId') challengeId: string,
    @Body() body: any,
    @Req() req: Request
  ) {
    this.checkAdmin(req);
    const id = this.validateChallengeId(challengeId);
    if (!body?.winners) this.bad('winners', 'winners required');
    
    const winners = this.validateWinners(body.winners);
    return this.sol.setWinnersListForChallenge(id, { winners });
  }

  @ApiSecurity('admin')
  @ApiOperation({ summary: 'Distribute rewards to winners' })
  @ApiParam({ name: 'challengeId', description: 'Challenge identifier', example: '123' })
  @ApiHeader({ name: 'x-admin-token', required: true, description: 'Admin token' })
  @ApiHeader({ name: 'x-owner', required: false, description: 'Owner public key (optional, for multi-owner challenges)' })
  @Post('send-bonus/:challengeId')
  @HttpCode(200)
  sendBonusForChallenge(
    @Param('challengeId') challengeId: string,
    @Req() req: Request
  ) {
    this.checkAdmin(req);
    const id = this.validateChallengeId(challengeId);
    
    const owner = this.getOwnerHeader(req);
    return this.sol.sendBonusToWinnersForChallenge(id, owner);
  }

  @ApiOperation({ summary: 'Check readiness for specific challenge' })
  @ApiParam({ name: 'challengeId', description: 'Challenge identifier', example: '123' })
  @Get('ready/:challengeId')
  async getReadyForChallenge(@Param('challengeId') challengeId: string) {
    const id = this.validateChallengeId(challengeId);
    
    const rpc = await this.sol.checkRpc();
    const programLoaded = await this.sol.checkProgram();
    const stateExists = await this.sol.checkStateForChallenge(id);
    const walletFunded = await this.sol.checkWallet();
    const configValid = this.sol.checkConfig();
    
    const status = rpc && programLoaded && walletFunded && configValid ? 
      (stateExists ? 'ready' : 'ready_to_initialize') : 'not_ready';
    
    const errors = [];
    if (!rpc) errors.push('RPC connection failed');
    if (!programLoaded) errors.push('Program not loaded');
    if (!stateExists) errors.push(`State for challenge ${challengeId} not found`);
    if (!walletFunded) errors.push('Wallet has insufficient balance');
    if (!configValid) errors.push('Configuration invalid');
    
    return {
      status,
      challengeId,
      rpc,
      programLoaded,
      stateExists,
      walletFunded,
      configValid,
      errors: errors.length > 0 ? errors : undefined
    };
  }

  // Admin config Endpoints

  @ApiSecurity('admin')
  @ApiOperation({ summary: 'Set fee for specific challenge' })
  @ApiParam({ name: 'challengeId', description: 'Challenge identifier', example: '123' })
  @ApiHeader({ name: 'x-admin-token', required: true, description: 'Admin token' })
  @ApiBody({ schema: { type: 'object', required: ['fee'], properties: { fee: { type: 'string' } } } })
  @Post('set-fee/:challengeId')
  @HttpCode(200)
  setFeeForChallenge(
    @Param('challengeId') challengeId: string,
    @Body() body: any,
    @Req() req: Request
  ) {
    this.checkAdmin(req);
    const id = this.validateChallengeId(challengeId);
    if (!body?.fee || typeof body.fee !== 'string') this.bad('fee', 'fee (string) required');
    const fee = this.validateFee(body.fee);
    return this.sol.setFeeForChallenge(id, { fee });
  }

  @ApiSecurity('admin')
  @ApiOperation({ summary: 'Set commission for specific challenge' })
  @ApiParam({ name: 'challengeId', description: 'Challenge identifier', example: '123' })
  @ApiHeader({ name: 'x-admin-token', required: true, description: 'Admin token' })
  @ApiBody({ schema: { type: 'object', required: ['commission'], properties: { commission: { type: 'number' } } } })
  @Post('set-commission/:challengeId')
  @HttpCode(200)
  setCommissionForChallenge(
    @Param('challengeId') challengeId: string,
    @Body() body: any,
    @Req() req: Request
  ) {
    this.checkAdmin(req);
    const id = this.validateChallengeId(challengeId);
    const commission = this.validateCommission(body?.commission);
    return this.sol.setCommissionForChallenge(id, { commission });
  }

  @ApiSecurity('admin')
  @ApiOperation({ summary: 'Set status for specific challenge' })
  @ApiParam({ name: 'challengeId', description: 'Challenge identifier', example: '123' })
  @ApiHeader({ name: 'x-admin-token', required: true, description: 'Admin token' })
  @ApiBody({ schema: { type: 'object', required: ['status'], properties: { status: { type: 'number' } } } })
  @Post('set-status/:challengeId')
  @HttpCode(200)
  setStatusForChallenge(
    @Param('challengeId') challengeId: string,
    @Body() body: any,
    @Req() req: Request
  ) {
    this.checkAdmin(req);
    const id = this.validateChallengeId(challengeId);
    const status = this.validateStatus(body?.status);
    return this.sol.setStatusForChallenge(id, { status });
  }

  @ApiSecurity('admin')
  @ApiOperation({ summary: 'Refund all subscribers for specific challenge' })
  @ApiParam({ name: 'challengeId', description: 'Challenge identifier', example: '123' })
  @ApiHeader({ name: 'x-admin-token', required: true, description: 'Admin token' })
  @Post('refund/:challengeId')
  @HttpCode(200)
  refundForChallenge(@Param('challengeId') challengeId: string, @Req() req: Request) {
    this.checkAdmin(req);
    const id = this.validateChallengeId(challengeId);
    return this.sol.refundForChallenge(id);
  }

  //  admin - wallet and treasury
  @ApiSecurity('admin')
  @ApiOperation({ summary: 'Whitelist owner for specific challenge' })
  @ApiParam({ name: 'challengeId', description: 'Challenge identifier', example: '123' })
  @ApiHeader({ name: 'x-admin-token', required: true, description: 'Admin token' })
  @ApiHeader({ name: 'x-owner', required: false, description: 'Owner public key (optional)' })
  @ApiBody({ schema: { type: 'object', required: ['newOwner'], properties: { newOwner: { type: 'string' } } } })
  @Post('set-owner/:challengeId')
  @HttpCode(200)
  setOwnerForChallenge(
    @Param('challengeId') challengeId: string,
    @Body() body: any,
    @Req() req: Request
  ) {
    this.checkAdmin(req);
    const id = this.validateChallengeId(challengeId);
    if (!body?.newOwner || typeof body.newOwner !== 'string') this.bad('newOwner', 'newOwner (string) required');
    const newOwner = this.validatePubkey(body.newOwner, 'newOwner');
    const owner = this.getOwnerHeader(req);
    return this.sol.setOwnerForChallenge(id, { newOwner, owner });
  }

  @ApiSecurity('admin')
  @ApiOperation({ summary: 'Remove whitelisted owner for specific challenge' })
  @ApiParam({ name: 'challengeId', description: 'Challenge identifier', example: '123' })
  @ApiHeader({ name: 'x-admin-token', required: true, description: 'Admin token' })
  @ApiHeader({ name: 'x-owner', required: false, description: 'Owner public key (optional)' })
  @ApiBody({ schema: { type: 'object', required: ['user'], properties: { user: { type: 'string' } } } })
  @Post('remove-owner/:challengeId')
  @HttpCode(200)
  removeOwnerForChallenge(
    @Param('challengeId') challengeId: string,
    @Body() body: any,
    @Req() req: Request
  ) {
    this.checkAdmin(req);
    const id = this.validateChallengeId(challengeId);
    if (!body?.user || typeof body.user !== 'string') this.bad('user', 'user (string) required');
    const user = this.validatePubkey(body.user, 'user');
    const owner = this.getOwnerHeader(req);
    return this.sol.removeOwnerForChallenge(id, { user, owner });
  }

  @ApiSecurity('admin')
  @ApiOperation({ summary: 'Cancel a subscriber for specific challenge (admin only)' })
  @ApiParam({ name: 'challengeId', description: 'Challenge identifier', example: '123' })
  @ApiHeader({ name: 'x-admin-token', required: true, description: 'Admin token' })
  @ApiHeader({ name: 'x-owner', required: false, description: 'Owner public key (optional)' })
  @ApiBody({ 
    schema: { 
      type: 'object', 
      required: ['subscriber'], 
      properties: { 
        subscriber: { 
          type: 'string', 
          example: '9WzDXwBbhgHqxw6uBHKVHvQK8196FoePKTLMS8EcnGMW',
          description: 'Subscriber wallet to cancel'
        } 
      } 
    } 
  })
  @Post('cancel-subscription/:challengeId')
  @HttpCode(200)
  cancelSubscriptionForChallenge(
    @Param('challengeId') challengeId: string,
    @Body() body: any,
    @Req() req: Request
  ) {
    this.checkAdmin(req);
    const id = this.validateChallengeId(challengeId);
    if (!body?.subscriber || typeof body.subscriber !== 'string') this.bad('subscriber', 'subscriber (string) required');
    const subscriber = this.validatePubkey(body.subscriber, 'subscriber');
    const owner = this.getOwnerHeader(req);
    return this.sol.cancelSubscriptionForChallenge(id, { subscriber, owner });
  }

  @ApiSecurity('admin')
  @ApiOperation({ summary: 'Update treasury address for specific challenge' })
  @ApiParam({ name: 'challengeId', description: 'Challenge identifier', example: '123' })
  @ApiHeader({ name: 'x-admin-token', required: true, description: 'Admin token' })
  @ApiHeader({ name: 'x-owner', required: false, description: 'Owner public key (optional)' })
  @ApiBody({ schema: { type: 'object', required: ['newTreasury'], properties: { newTreasury: { type: 'string' } } } })
  @Post('set-treasury/:challengeId')
  @HttpCode(200)
  setTreasuryForChallenge(
    @Param('challengeId') challengeId: string,
    @Body() body: any,
    @Req() req: Request
  ) {
    this.checkAdmin(req);
    const id = this.validateChallengeId(challengeId);
    if (!body?.newTreasury || typeof body.newTreasury !== 'string') this.bad('newTreasury', 'newTreasury (string) required');
    const newTreasury = this.validatePubkey(body.newTreasury, 'newTreasury');
    const owner = this.getOwnerHeader(req);
    return this.sol.setTreasuryForChallenge(id, { newTreasury, owner });
  }
}

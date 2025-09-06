// api controller
import { Controller, Get, Post, Body, HttpException, HttpCode, Param } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { SolanaService } from '../solana/solana.service';
import { 
  InitializeDto, 
  BuildSubscribeDto, 
  WinnersDto, 
  RefundBatchDto, 
  SetFeeDto, 
  SetCommissionDto, 
  SetStatusDto, 
  CancelSubscriptionDto,
  SetOwnerDto,
  RemoveOwnerDto
} from './dto/api.dto';

@ApiTags('solana')
@Controller('api')
export class ApiController {
  constructor(private readonly sol: SolanaService) {}

  //subscribe() 
  @ApiOperation({ summary: 'Subscribe to challenge (deprecated)', description: 'Use /api/build/subscribe instead' })
  @ApiResponse({ status: 501, description: 'Not implemented - use build/subscribe' })
  @Post('subscribe')
  @HttpCode(501)
  subscribe() {
    throw new HttpException(
      { code: 'NOT_IMPLEMENTED', message: 'Use /api/build/subscribe; user must sign' },
      501
    );
  }

  @Post('build/subscribe-tx')
  @HttpCode(200)
  buildSubscribeTx(@Body() body: { subscriber: string }) {
    return this.sol.buildSubscribeTx(body);
  }

  // initialize
  @Post('initialize')
  @HttpCode(200)
  initialize(@Body() body: { challengeId: string | number | bigint; fee: string | number | bigint; commission: string | number | bigint }) {
    return this.sol.initialize(body);
  }

  // setWinnersList 
  @Post('winners')
  @HttpCode(200)
  setWinnersList(@Body() body: { winners: string[] }) {
    if (!Array.isArray(body.winners) || body.winners.length === 0) {
      throw new HttpException({ code: 'BAD_INPUT', message: 'winners must be a non-empty array' }, 400);
    }
    // ensure strings look like base58 keys
    for (const w of body.winners) {
      if (typeof w !== 'string' || w.length < 32 || w.length > 64) {
        throw new HttpException({ code: 'BAD_INPUT', message: `invalid winner pubkey: ${w}` }, 400);
      }
    }
    return this.sol.setWinnersList(body);
  }

  
  // sendBonusToWinners()
   
  @Post('send-bonus-to-winners')
  @HttpCode(200)
  sendBonusToWinners() {
    return this.sol.sendBonusToWinners();
  }

  //Back-compat alias for older clients 
  @Post('distribute')
  @HttpCode(200)
  distributeAlias() {
    return this.sol.sendBonusToWinners();
  }

  
   //refundBatch
   //Remaining accounts must match the subscribers array order
   
  @Post('refund-batch')
  @HttpCode(200)
  refundBatch(@Body() body: { subscribers: string[] }) {
    if (!body.subscribers || !Array.isArray(body.subscribers) || body.subscribers.length === 0) {
      throw new HttpException(
        { code: 'INVALID_INPUT', message: 'subscribers array required and must not be empty' },
        400
      );
    }
    return this.sol.refundBatch(body);
  }

  //Back-compat alias 
  @Post('refund')
  @HttpCode(200)
  refundAlias(@Body() body: { subscribers: string[] }) {
    return this.sol.refundBatch(body);
  }

  // withdrawFunds() 
  @Post('withdraw-funds')
  @HttpCode(200)
  withdrawFunds() {
    return this.sol.withdrawFunds();
  }

  // setFee
  @Post('set-fee')
  @HttpCode(200)
  setFee(@Body() body: { fee?: string | number; newFee?: string | number }) {
    const fee = body.fee ?? body.newFee;
    if (fee === undefined) {
      throw new HttpException({ code: 'BAD_INPUT', message: 'Missing fee/newFee' }, 400);
    }
    return this.sol.setFee({ fee });
  }

  // setCommision
  @Post('set-commission')
  @HttpCode(200)
  setCommision(@Body() body: { commissionPercentage: string | number }) {
    const n = Number(body.commissionPercentage);
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      throw new HttpException({ code: 'BAD_INPUT', message: 'commissionPercentage must be 0..100' }, 400);
    }
    return this.sol.setCommision({ commissionPercentage: n });
  }

  // setOwner
  @Post('set-owner')
  @HttpCode(200)
  setOwner(@Body() body: { newOwner: string }) {
    if (!body.newOwner || typeof body.newOwner !== 'string') {
      throw new HttpException(
        { code: 'INVALID_INPUT', message: 'newOwner string required' },
        400
      );
    }
    return this.sol.setOwner(body);
  }

  @Get('events/:signature')
  events(@Param('signature') signature: string) {
    return this.sol.events(signature);
  }

  // removeOwner
  @Post('remove-owner')
  @HttpCode(200)
  removeOwner(@Body() body: { user: string }) {
    if (!body.user || typeof body.user !== 'string') {
      throw new HttpException(
        { code: 'INVALID_INPUT', message: 'user string required' },
        400
      );
    }
    return this.sol.removeOwner(body);
  }

  // setStatus
  @Post('set-status')
  @HttpCode(200)
  setStatus(@Body() body: { status: number }) {
    return this.sol.setStatus(body);
  }

  // cancelSubscription
  @Post('cancel-subscription')
  @HttpCode(200)
  cancelSubscription(@Body() body: { subscriber: string }) {
    return this.sol.cancelSubscription(body);
  }


  // GET /api/state 
  @Get('state')
  getState() {
    return this.sol.getState();
  }

  @Get('fee')
  getFee() {
    return this.sol.getFee();
  }

  @Get('commission')
  getCommission() {
    return this.sol.getCommission();
  }

  @Get('status')
  getStatus() {
    return this.sol.getStatus();
  }

  @Get('challenge-id')
  getChallengeId() {
    return this.sol.getChallengeId();
  }

  @Get('winners')
  async getWinners() {
    const s = await this.sol.getState();
    return { winners: s.winnersList };
  }


  @Get('op-counter')
  getOperationFee() {
    return this.sol.getOperationFee();
  }
}

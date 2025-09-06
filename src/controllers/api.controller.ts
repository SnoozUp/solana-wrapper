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

  @ApiOperation({ summary: 'Build unsigned subscription transaction', description: 'Creates unsigned transaction for user to sign and subscribe' })
  @ApiResponse({ status: 200, description: 'Unsigned transaction returned', schema: { type: 'object', properties: { txBase64: { type: 'string' } } } })
  @Post('build/subscribe-tx')
  @HttpCode(200)
  buildSubscribeTx(@Body() body: BuildSubscribeDto) {
    return this.sol.buildSubscribeTx(body);
  }

  // initialize
  @ApiOperation({ summary: 'Initialize new challenge', description: 'Create new challenge with fee and settings' })
  @ApiResponse({ status: 200, description: 'Challenge initialized', schema: { type: 'object', properties: { signature: { type: 'string' }, state: { type: 'string' } } } })
  @Post('initialize')
  @HttpCode(200)
  initialize(@Body() body: InitializeDto) {
    return this.sol.initialize(body);
  }

  // setWinnersList 
  @ApiOperation({ summary: 'Set challenge winners', description: 'Store winner wallet addresses' })
  @ApiResponse({ status: 200, description: 'Winners set', schema: { type: 'object', properties: { signature: { type: 'string' } } } })
  @ApiResponse({ status: 400, description: 'Invalid winners array or invalid wallet addresses' })
  @Post('winners')
  @HttpCode(200)
  setWinnersList(@Body() body: WinnersDto) {
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
  @ApiOperation({ summary: 'Distribute prizes to winners', description: 'Send prize pool to winners equally' })
  @ApiResponse({ status: 200, description: 'Prizes distributed', schema: { type: 'object', properties: { signature: { type: 'string' }, winners: { type: 'array', items: { type: 'string' } } } } })
  @Post('send-bonus-to-winners')
  @HttpCode(200)
  sendBonusToWinners() {
    return this.sol.sendBonusToWinners();
  }

  //Back-compat alias for older clients 
  @ApiOperation({ summary: 'Distribute prizes (alias)', description: 'Alias for send-bonus-to-winners endpoint' })
  @ApiResponse({ status: 200, description: 'Prizes distributed' })
  @Post('distribute')
  @HttpCode(200)
  distributeAlias() {
    return this.sol.sendBonusToWinners();
  }

  
   //refundBatch
   //Remaining accounts must match the subscribers array order
  @ApiOperation({ summary: 'Refund subscribers', description: 'Return entry fees to subscribers' })
  @ApiResponse({ status: 200, description: 'Refunds processed', schema: { type: 'object', properties: { signature: { type: 'string' } } } })
  @ApiResponse({ status: 400, description: 'Invalid subscribers array or empty array' })
  @Post('refund-batch')
  @HttpCode(200)
  refundBatch(@Body() body: RefundBatchDto) {
    if (!body.subscribers || !Array.isArray(body.subscribers) || body.subscribers.length === 0) {
      throw new HttpException(
        { code: 'INVALID_INPUT', message: 'subscribers array required and must not be empty' },
        400
      );
    }
    return this.sol.refundBatch(body);
  }

  //Back-compat alias 
  @ApiOperation({ summary: 'Refund subscribers (alias)', description: 'Alternative refund endpoint' })
  @ApiResponse({ status: 200, description: 'Refunds processed' })
  @Post('refund')
  @HttpCode(200)
  refundAlias(@Body() body: RefundBatchDto) {
    return this.sol.refundBatch(body);
  }

  // withdrawFunds() 
  @ApiOperation({ summary: 'Withdraw remaining funds', description: 'Transfer remaining balance to treasury' })
  @ApiResponse({ status: 200, description: 'Funds withdrawn', schema: { type: 'object', properties: { signature: { type: 'string' } } } })
  @Post('withdraw-funds')
  @HttpCode(200)
  withdrawFunds() {
    return this.sol.withdrawFunds();
  }

  // setFee
  @ApiOperation({ summary: 'Update entry fee', description: 'Set new entry fee in lamports' })
  @ApiResponse({ status: 200, description: 'Fee updated', schema: { type: 'object', properties: { signature: { type: 'string' } } } })
  @Post('set-fee')
  @HttpCode(200)
  setFee(@Body() body: SetFeeDto) {
    return this.sol.setFee({ fee: body.fee });
  }

  // setCommision
  @ApiOperation({ summary: 'Update commission rate', description: 'Set commission percentage (0-100)' })
  @ApiResponse({ status: 200, description: 'Commission updated', schema: { type: 'object', properties: { signature: { type: 'string' } } } })
  @ApiResponse({ status: 400, description: 'Commission percentage must be between 0-100' })
  @Post('set-commission')
  @HttpCode(200)
  setCommision(@Body() body: SetCommissionDto) {
    if (body.commissionPercentage < 0 || body.commissionPercentage > 100) {
      throw new HttpException({ code: 'BAD_INPUT', message: 'commissionPercentage must be 0..100' }, 400);
    }
    return this.sol.setCommision({ commissionPercentage: body.commissionPercentage });
  }

  // setOwner
  @ApiOperation({ summary: 'Add allowed owner (whitelist)', description: 'Add wallet to owners whitelist' })
  @ApiResponse({ status: 200, description: 'Owner added', schema: { type: 'object', properties: { signature: { type: 'string' } } } })
  @ApiResponse({ status: 400, description: 'Invalid input/ too many owners' })
  @Post('set-owner')
  @HttpCode(200)
  setOwner(@Body() body: SetOwnerDto) {
    return this.sol.setOwner(body);
  }

  @ApiOperation({ summary: 'Get transaction events', description: 'Retrieve emitted events for a given transaction signature' })
  @ApiResponse({ status: 200, description: 'Events retrieved' })
  @ApiParam({ name: 'signature', description: 'Transaction signature to get events for' })
  @Get('events/:signature')
  events(@Param('signature') signature: string) {
    return this.sol.events(signature);
  }

  // removeOwner
  @ApiOperation({ summary: 'Remove allowed owner', description: 'Remove wallet from owners whitelist' })
  @ApiResponse({ status: 200, description: 'Owner removed', schema: { type: 'object', properties: { signature: { type: 'string' } } } })
  @ApiResponse({ status: 400, description: 'Invalid input' })
  @Post('remove-owner')
  @HttpCode(200)
  removeOwner(@Body() body: RemoveOwnerDto) {
    return this.sol.removeOwner(body);
  }

  // setStatus
  @ApiOperation({ summary: 'Update challenge status', description: 'Change status: 0=PENDING 1=IN_PROGRESS 2=CLOSED 3=CANCELED' })
  @ApiResponse({ status: 200, description: 'Status updated', schema: { type: 'object', properties: { signature: { type: 'string' } } } })
  @Post('set-status')
  @HttpCode(200)
  setStatus(@Body() body: SetStatusDto) {
    return this.sol.setStatus(body);
  }

  // cancelSubscription
  @ApiOperation({ summary: 'Cancel single subscription', description: 'Cancel subscriber and refund fee' })
  @ApiResponse({ status: 200, description: 'Subscription canceled', schema: { type: 'object', properties: { signature: { type: 'string' } } } })
  @Post('cancel-subscription')
  @HttpCode(200)
  cancelSubscription(@Body() body: CancelSubscriptionDto) {
    return this.sol.cancelSubscription(body);
  }


  // GET /api/state 
  @ApiOperation({ summary: 'Get full challenge state', description: 'Returns complete challenge info: subscribers winners and settings' })
  @ApiResponse({ status: 200, description: 'Challenge state retrieved' })
  @Get('state')
  getState() {
    return this.sol.getState();
  }

  @ApiOperation({ summary: 'Get entry fee', description: 'Returns current entry fee in lamports' })
  @ApiResponse({ status: 200, description: 'Fee retrieved', schema: { type: 'object', properties: { fee: { type: 'string' } } } })
  @Get('fee')
  getFee() {
    return this.sol.getFee();
  }

  @ApiOperation({ summary: 'Get commission rate', description: 'Returns commission percentage (0-100)' })
  @ApiResponse({ status: 200, description: 'Commission retrieved', schema: { type: 'object', properties: { commission: { type: 'number' } } } })
  @Get('commission')
  getCommission() {
    return this.sol.getCommission();
  }

  @ApiOperation({ summary: 'Get challenge status', description: 'Returns status: 0=PENDING 1=IN_PROGRESS 2=CLOSED 3=CANCELED' })
  @ApiResponse({ status: 200, description: 'Status retrieved', schema: { type: 'object', properties: { status: { type: 'number' } } } })
  @Get('status')
  getStatus() {
    return this.sol.getStatus();
  }

  @ApiOperation({ summary: 'Get challenge events', description: 'Returns challenge events and transactions' })
  @ApiResponse({ status: 200, description: 'Challenge ID retrieved', schema: { type: 'object', properties: { challengeId: { type: 'string' } } } })
  @Get('challenge-id')
  getChallengeId() {
    return this.sol.getChallengeId();
  }

  @ApiOperation({ summary: 'Get winners list', description: 'Returns winner wallet addresses' })
  @ApiResponse({ status: 200, description: 'Winners retrieved', schema: { type: 'object', properties: { winners: { type: 'array', items: { type: 'string' } } } } })
  @Get('winners')
  async getWinners() {
    const s = await this.sol.getState();
    return { winners: s.winnersList };
  }

  @ApiOperation({ summary: 'Get operation counter', description: 'Returns number of admin operations performed' })
  @ApiResponse({ status: 200, description: 'Operation counter retrieved', schema: { type: 'object', properties: { opCounter: { type: 'string' } } } })
  @Get('op-counter')
  getOperationFee() {
    return this.sol.getOperationFee();
  }
}

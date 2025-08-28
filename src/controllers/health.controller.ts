// health.controller.ts
import { Controller, Get, Res } from '@nestjs/common';
import { Response } from 'express';
import { SolanaService } from '../solana/solana.service';

@Controller()
export class HealthController {
  constructor(private readonly sol: SolanaService) {}

  /** Liveness of the wrapper itself */
  @Get('health')
  health() {
    return { ok: true };
  }

  /** Readiness: rpc + program + state existence */
  @Get('ready')
  async ready(@Res() res: Response) {
    const s = await this.sol.ready();
    const ok = s.rpc && s.programLoaded; // state may be absent prior to initialize
    return res.status(ok ? 200 : 503).json({ status: ok ? 'ready' : 'not_ready', ...s });
  }
}

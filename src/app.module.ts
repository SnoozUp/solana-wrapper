import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { SolanaService } from './solana/solana.service';
import { ApiController } from './controllers/api.controller';
import { HealthController } from './controllers/health.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
  ],
  controllers: [HealthController, ApiController],
  providers: [
    SolanaService,
  ],
})
export class AppModule {}

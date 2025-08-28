import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import helmet from 'helmet';
import { randomUUID } from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import * as express from 'express';

declare module 'express-serve-static-core' {
  interface Request { requestId?: string }
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Remove the x-powered-by header for security
  app.getHttpAdapter().getInstance().disable('x-powered-by');

  // Set JSON payload limits
  app.use(express.json({ limit: process.env.JSON_LIMIT ?? '200kb' }));
  app.use(express.urlencoded({ extended: false, limit: process.env.JSON_LIMIT ?? '200kb' }));

  // Disable caching for API responses
  app.use((_req: Request, res: Response, next: NextFunction) => { 
    res.setHeader('Cache-Control', 'no-store'); 
    next(); 
  });

  // Add security headers with helmet
  app.use(helmet({ frameguard: { action: 'deny' }, contentSecurityPolicy: false }));

  // Add request tracking
  app.use((req: Request, res: Response, next: NextFunction) => {
    const incoming = req.header('x-request-id');
    const id = incoming && incoming.length <= 128 ? incoming : randomUUID();
    req.requestId = id;
    res.setHeader('X-Request-ID', id);
    next();
  });

  // Enable CORS if configured
  const rawOrigin = process.env.CORS_ORIGIN;
  if (rawOrigin) {
    const origins = rawOrigin === '*' ? '*' : rawOrigin.split(',').map(s => s.trim()).filter(Boolean);
    app.enableCors({ origin: origins });
  }

  app.enableShutdownHooks();

  // Start server on localhost
  const host = process.env.HOST ?? '127.0.0.1';
  const port = Number(process.env.PORT ?? 3001);
  await app.listen(port, host);
  console.log(`Server running on http://${host}:${port}`);
}
bootstrap();
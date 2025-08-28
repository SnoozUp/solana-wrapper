import { HttpException } from '@nestjs/common';

export class AppError extends HttpException {
  constructor(code: string, status: number, message: string) {
    super({ code, status, message }, status);
  }
}

export const BadRequest = (code: string, message: string) =>
  new AppError(code, 400, message);

export const ServiceUnavailable = (code: string, message: string) =>
  new AppError(code, 503, message);

export const MethodNotAllowed = (msg = 'Method Not Allowed') =>
  new AppError('METHOD_NOT_ALLOWED', 405, msg);

export const NotImplemented = (code = 'NOT_IMPLEMENTED', msg = 'Not implemented') =>
  new AppError(code, 501, msg);

export const Unauthorized = (code = 'UNAUTHORIZED', msg = 'Unauthorized') =>
  new AppError(code, 401, msg);

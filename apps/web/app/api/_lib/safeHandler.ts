import { log } from '@pat87creator/logger';
import { isProd } from '../../../lib/runtime';

type Handler = (request: Request) => Promise<Response>;

export function withSafeApiHandler(route: string, handler: Handler): Handler {
  return async (request: Request) => {
    try {
      return await handler(request);
    } catch (error) {
      log('error', 'Unhandled API error', {
        route,
        method: request.method,
        error: error instanceof Error ? error.message : 'unknown_error'
      });

      if (!isProd) {
        log('debug', 'API error details', {
          route,
          stack: error instanceof Error ? error.stack : 'non_error_thrown'
        });
      }

      return Response.json({ error: 'internal_server_error' }, { status: 500 });
    }
  };
}

import './lib/patchExpressAsync';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import v1 from './routes/v1';
import gitops from './routes/gitops';
import auth from './routes/auth';
import { attachAuth } from './middleware/requireAuth';
import { isHttpError } from './lib/httpError';
import { formatLogTimestampStyled, installConsoleTimestamps } from './lib/log';

installConsoleTimestamps();

morgan.token('grid-date', () => formatLogTimestampStyled());

export function createApp() {
  const app = express();

  app.use(helmet());
  // Optional allow-list: GRID_CORS_ORIGIN=https://a.com,https://b.com
  const corsOrigin = (process.env.GRID_CORS_ORIGIN || '').trim();
  app.use(
    cors(
      corsOrigin
        ? {
            origin: corsOrigin.split(',').map((s) => s.trim()).filter(Boolean),
            credentials: true,
          }
        : undefined
    )
  );
  app.use(express.json({ limit: '2mb' }));
  app.use(
    morgan(':grid-date :method :url :status :response-time ms - :res[content-length]')
  );

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.use('/api/v1', (req, res, next) => {
    void attachAuth(req, res, next);
  });
  app.use('/api/v1', auth);
  app.use('/api/v1', v1);
  app.use('/api/v1', gitops);

  app.use(
    (
      err: Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction
    ) => {
      if (isHttpError(err)) {
        res.status(err.status).json({
          code: err.code,
          message: err.message,
          ...(err.details ? { details: err.details } : {}),
        });
        return;
      }
      console.error(err);
      res.status(500).json({
        code: 'internal_error',
        message: err.message || 'Internal error',
      });
    }
  );

  return app;
}

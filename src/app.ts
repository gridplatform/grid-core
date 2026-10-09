import './lib/patchExpressAsync';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import v1 from './routes/v1';
import gitops from './routes/gitops';
import auth from './routes/auth';
import { attachAuth } from './middleware/requireAuth';

export function createApp() {
  const app = express();

  app.use(helmet());
  app.use(cors());
  app.use(express.json({ limit: '2mb' }));
  app.use(morgan('dev'));

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
      console.error(err);
      res.status(500).json({ code: 'internal_error', message: err.message });
    }
  );

  return app;
}

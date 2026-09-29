import type { User } from './api';

declare global {
  namespace Express {
    interface Request {
      /** Set by attachAuth middleware when a valid session token is presented. */
      gridUser?: User;
    }
  }
}

export {};

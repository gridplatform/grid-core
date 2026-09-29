/**
 * Deploy / lifecycle entrypoint for grid-core.
 *
 * Implementation lives in lifecycleService.ts (plan | apply | destroy).
 * This module re-exports so existing imports keep working.
 */
export {
  runLifecycle,
  runInfrastructureDeploy,
} from './lifecycleService';

export type { LifecycleMode } from '../types/api';

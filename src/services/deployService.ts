/** Re-exports lifecycleService (plan | apply | destroy). */
export {
  runLifecycle,
  runInfrastructureDeploy,
} from './lifecycleService';

export type { LifecycleMode } from '../types/api';

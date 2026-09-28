/**
 * Product flag surface kept under its original name so existing imports of
 * `features` keep resolving. Everything is defined in ./featureFlags.
 */

export {
  productFlags as features,
  isProductEnabled,
  type ProductFlagKey as FeatureKey,
} from './featureFlags';

import { REGISTERED_ROUTES } from './registry';

export type RewardCapabilityKind = 'rate' | 'lp';

export interface RewardCapabilityPolicy {
  rewardTruth: string;
  exactIdentity: string;
  zeroProofRoles: readonly string[];
  unsupportedPolicy: 'unknown' | 'non-annualizable' | 'not-applicable';
}

export interface RewardCapability extends RewardCapabilityPolicy {
  route: string;
  kind: RewardCapabilityKind;
}

/**
 * Audited inventory derived from the executable route registry. A route cannot
 * execute without carrying its capability policy in REGISTERED_ROUTES.
 */
export const REWARD_CAPABILITIES: readonly RewardCapability[] = REGISTERED_ROUTES.map(
  ({ route, kind, capability }) => ({ route, kind, ...capability }),
);

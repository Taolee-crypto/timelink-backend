/**
 * Canonical TimeLink creator/platform distribution policy.
 * Product policy: 70% to the creator, 30% to the platform.
 * Keep TL_P / TL_A / TL_B provenance separate; this module defines only
 * the percentage split, not the destination bucket for each source.
 */
export const CREATOR_SHARE_RATE = 0.70;
export const PLATFORM_SHARE_RATE = 0.30;

/**
 * Shared memory-tier API. The canonical implementation stays in the Node tree
 * because setup-installed Node modules must remain self-contained.
 */
export {
    getMemoryTier,
    getTierLimits,
    type MemoryTier,
    type TierLimits,
} from '../node/_internal/memory';

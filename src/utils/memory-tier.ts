/**
 * Memory tier detection for buffer sizing. Reads total system memory once at
 * startup and classifies it, so 64 MB embedded devices and multi-GB desktops
 * share one codebase.
 *
 * Thresholds: LOW ≤ 128 MB, NORMAL 128 MB – 1 GB, HIGH > 1 GB.
 */

const os = import.meta.use('os');

export type MemoryTier = 'low' | 'normal' | 'high';

export interface TierLimits {
    /** ReadableStream ByteLengthQueuingStrategy highWaterMark (bytes). */
    streamHighWaterMark: number;
    /** Max bytes buffered in performFetch before the stream controller attaches. */
    maxPendingBodyBytes: number;
    /** Read buffer size for fs / child_process / tty read loops (bytes). */
    readBufSize: number;
    /** Cap for hook payload base64 reporting and post-data buffering (bytes). */
    hookPayloadCap: number;
    /** Max response bytes reserved for inspector/CDP body preview (bytes). */
    inspectorPreviewBodyBytes: number;
}

const LOW_MAX   = 128 * 1024 * 1024;
const HIGH_MIN  = 1024 * 1024 * 1024;

const TIER_LOW: TierLimits = {
    streamHighWaterMark:  16 * 1024,
    maxPendingBodyBytes:  16 * 1024,
    readBufSize:          16 * 1024,
    hookPayloadCap:       16 * 1024,
    inspectorPreviewBodyBytes: 256 * 1024,
};

const TIER_NORMAL: TierLimits = {
    streamHighWaterMark:  64 * 1024,
    maxPendingBodyBytes:  64 * 1024,
    readBufSize:          64 * 1024,
    hookPayloadCap:       64 * 1024,
    inspectorPreviewBodyBytes: 1024 * 1024,
};

const TIER_HIGH: TierLimits = {
    streamHighWaterMark: 256 * 1024,
    maxPendingBodyBytes: 256 * 1024,
    readBufSize:         256 * 1024,
    hookPayloadCap:      256 * 1024,
    inspectorPreviewBodyBytes: 2 * 1024 * 1024,
};

let _tier: MemoryTier | null = null;
let _limits: TierLimits | null = null;

function detect(): void {
    const totalBytes = (() => {
        try {
            return os.memoryUsage()['os.total'] ?? 0;
        } catch {
            // Detection failed: fall through to NORMAL, as the old detector did.
            return 256 * 1024 * 1024;
        }
    })();

    if (totalBytes > 0 && totalBytes <= LOW_MAX) {
        _tier = 'low';
        _limits = TIER_LOW;
    } else if (totalBytes > HIGH_MIN) {
        _tier = 'high';
        _limits = TIER_HIGH;
    } else {
        _tier = 'normal';
        _limits = TIER_NORMAL;
    }
}

/** The detected memory tier. */
export function getMemoryTier(): MemoryTier {
    if (_tier === null) detect();
    return _tier!;
}

/** Buffer limits for the detected tier. */
export function getTierLimits(): TierLimits {
    if (_limits === null) detect();
    return _limits!;
}

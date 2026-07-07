/**
 * Memory tier detection for buffer sizing adapted for NodeJS.
 *
 * Reads total system memory once at startup, classifies into a tier, and
 * exposes per-stream buffer limits so that 64 MB embedded devices and
 * 4 GB desktops can coexist in the same codebase.
 *
 * ┌──────────┬───────────────┬─────────────┬──────────────┬─────────────┬──────────────┐
 * │  Tier    │  Total RAM    │  HWM (BLS)  │  Pending cap │  Read buf   │  Hook cap    │
 * ├──────────┼───────────────┼─────────────┼──────────────┼─────────────┼──────────────┤
 * │  LOW     │  ≤ 128 MB     │   16 KB     │    16 KB     │   16 KB     │   16 KB      │
 * │  NORMAL  │  128 MB – 1 GB│   64 KB     │    64 KB     │   64 KB     │   64 KB      │
 * │  HIGH    │  > 1 GB       │  256 KB     │   256 KB     │  256 KB     │  256 KB      │
 * └──────────┴───────────────┴─────────────┴──────────────┴─────────────┴──────────────┘
 *
 * HWM = ReadableStream highWaterMark (ByteLengthQueuingStrategy)
 * Pending cap = MAX_PENDING_BODY_BYTES in performFetch (controller not yet attached)
 * Read buf   = fs / child_process / tty read loop buffer size
 * Hook cap   = hook payload base64 reporting + post-data buffer cap
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

// ── Thresholds (bytes) ───────────────────────────────────────────────────────

const LOW_MAX   = 128 * 1024 * 1024;   // 128 MB
const HIGH_MIN  = 1024 * 1024 * 1024;  // 1 GB

// ── Tier definitions ─────────────────────────────────────────────────────────

const TIER_LOW: TierLimits = {
    streamHighWaterMark:  16 * 1024,    //  16 KB  —  ~1 curl chunk
    maxPendingBodyBytes:  16 * 1024,    //  16 KB
    readBufSize:          16 * 1024,    //  16 KB
    hookPayloadCap:       16 * 1024,    //  16 KB
    inspectorPreviewBodyBytes: 256 * 1024, // 256 KB
};

const TIER_NORMAL: TierLimits = {
    streamHighWaterMark:  64 * 1024,    //  64 KB  —  ~4 curl chunks
    maxPendingBodyBytes:  64 * 1024,    //  64 KB
    readBufSize:          64 * 1024,    //  64 KB
    hookPayloadCap:       64 * 1024,    //  64 KB
    inspectorPreviewBodyBytes: 1024 * 1024, // 1 MiB
};

const TIER_HIGH: TierLimits = {
    streamHighWaterMark: 256 * 1024,    // 256 KB  —  ~16 curl chunks
    maxPendingBodyBytes: 256 * 1024,    // 256 KB
    readBufSize:         256 * 1024,    // 256 KB
    hookPayloadCap:      256 * 1024,    // 256 KB
    inspectorPreviewBodyBytes: 2 * 1024 * 1024, // 2 MiB
};

// ── Detection (runs once, cached) ────────────────────────────────────────────

let _tier: MemoryTier | null = null;
let _limits: TierLimits | null = null;

function detect(): void {
    let totalBytes: number;
    try {
        totalBytes = os.memoryUsage()['os.total'] ?? 0;
    } catch {
        // If detection fails, assume NORMAL to be safe.
        totalBytes = 256 * 1024 * 1024;
    }

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
    return _tier ?? 'normal';
}

/** Buffer limits for the detected tier. */
export function getTierLimits(): TierLimits {
    if (_limits === null) detect();
    return _limits ?? TIER_NORMAL;
}

/**
 * Allow manual override (e.g. from env var or build flag).
 * Call before any stream/fetch code runs.
 */
export function setMemoryTier(tier: MemoryTier): void {
    _tier = tier;
    _limits = tier === 'low' ? TIER_LOW
            : tier === 'high' ? TIER_HIGH
            : TIER_NORMAL;
}

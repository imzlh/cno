import type { StorageEstimate, StorageManager } from './types';

const os = import.meta.use('os');

class StorageManagerImpl implements StorageManager {
    async estimate(): Promise<StorageEstimate> {
        const memory = os.memoryUsage();
        const totalBytes = memory['os.total'];
        const freeBytes = memory['os.free'];
        const usedBytes = memory['os.used'];

        const quota = Math.min(totalBytes, 2 * 1024 * 1024 * 1024);

        return {
            usage: usedBytes,
            quota: quota,
            usageDetails: {
                indexedDB: 0,
                caches: 0,
                serviceWorkerRegistrations: 0,
            },
        };
    }

    async persist(): Promise<boolean> {
        return true;
    }

    async persisted(): Promise<boolean> {
        return true;
    }
}

export function createStorageManager(): StorageManager {
    return new StorageManagerImpl();
}

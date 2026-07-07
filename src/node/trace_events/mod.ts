const enabledCounts = new Map<string, number>();

export interface CreateTracingOptions {
    categories: string[];
}

export interface Tracing {
    readonly categories: string;
    readonly enabled: boolean;
    enable(): void;
    disable(): void;
}

function validateCategories(options: unknown): string[] {
    if (options === null || typeof options !== 'object') {
        throw new TypeError('The "options" argument must be of type object');
    }

    const categories = (options as { categories?: unknown }).categories;
    if (!Array.isArray(categories)) {
        throw new TypeError('The "options.categories" property must be an instance of Array');
    }
    if (categories.length === 0) {
        throw new TypeError('At least one category is required');
    }
    for (let i = 0; i < categories.length; i++) {
        if (typeof categories[i] !== 'string') {
            throw new TypeError(`The "options.categories[${i}]" property must be of type string`);
        }
    }
    return categories;
}

export function createTracing(options: CreateTracingOptions): Tracing {
    const categories = validateCategories(options);
    const enabledCategories = Array.from(new Set(categories.filter(Boolean)));
    let enabled = false;

    return {
        categories: categories.join(','),
        get enabled() {
            return enabled;
        },
        enable() {
            if (enabled) return;
            enabled = true;
            for (const category of enabledCategories) {
                enabledCounts.set(category, (enabledCounts.get(category) ?? 0) + 1);
            }
        },
        disable() {
            if (!enabled) return;
            enabled = false;
            for (const category of enabledCategories) {
                const count = (enabledCounts.get(category) ?? 0) - 1;
                if (count > 0) enabledCounts.set(category, count);
                else enabledCounts.delete(category);
            }
        },
    };
}

export function getEnabledCategories(): string | undefined {
    if (enabledCounts.size === 0) return undefined;
    return Array.from(enabledCounts.keys()).sort().join(',');
}

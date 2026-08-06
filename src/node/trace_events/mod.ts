const enabledCounts = new Map<string, number>();

export type CreateTracingOptions = {
    categories: string[];
};

export type Tracing = {
    readonly categories: string;
    readonly enabled: boolean;
    enable(): void;
    disable(): void;
};

/** Node stamps ERR_INVALID_ARG_TYPE on these; callers branch on .code. */
function invalidArgType(message: string): TypeError {
    return Object.assign(new TypeError(message), { code: 'ERR_INVALID_ARG_TYPE' });
}

function validateCategories(options: unknown): string[] {
    if (options === null || typeof options !== 'object') {
        throw invalidArgType('The "options" argument must be of type object');
    }

    const categories = (options as { categories?: unknown }).categories;
    if (!Array.isArray(categories)) {
        throw invalidArgType('The "options.categories" property must be an instance of Array');
    }
    if (categories.length === 0) {
        throw Object.assign(new TypeError('At least one category is required'), {
            code: 'ERR_TRACE_EVENTS_CATEGORY_REQUIRED',
        });
    }
    for (let i = 0; i < categories.length; i++) {
        if (typeof categories[i] !== 'string') {
            throw invalidArgType(`The "options.categories[${i}]" property must be of type string`);
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

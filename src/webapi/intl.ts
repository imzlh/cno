// complete-intl.ts

type LocaleCode = 'zh' | 'zh-CN' | 'zh-TW' | 'zh-HK' | 'en' | 'en-US' | 'en-GB';
type CurrencyCode = 'USD' | 'EUR' | 'GBP' | 'CNY' | 'JPY' | 'KRW' | 'TWD' | 'HKD';
type TimeUnit = 'second' | 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year';

// ============ Locale Data ============
const localeData = {
    zh: {
        currency: {
            USD: '美元', EUR: '欧元', GBP: '英镑', CNY: '人民币',
            JPY: '日元', KRW: '韩元', TWD: '新台币', HKD: '港币'
        },
        currencySymbol: {
            USD: '$', EUR: '€', GBP: '£', CNY: '¥',
            JPY: '¥', KRW: '₩', TWD: 'NT$', HKD: 'HK$'
        },
        months: ['一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月'],
        monthsShort: ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'],
        weekdays: ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'],
        weekdaysShort: ['周日', '周一', '周二', '周三', '周四', '周五', '周六'],
        weekdaysNarrow: ['日', '一', '二', '三', '四', '五', '六'],
        relativeTime: {
            future: '{0}后',
            past: '{0}前',
            units: {
                second: { one: '{0}秒', other: '{0}秒' },
                minute: { one: '{0}分钟', other: '{0}分钟' },
                hour: { one: '{0}小时', other: '{0}小时' },
                day: { one: '{0}天', other: '{0}天' },
                week: { one: '{0}周', other: '{0}周' },
                month: { one: '{0}个月', other: '{0}个月' },
                year: { one: '{0}年', other: '{0}年' }
            },
            auto: {
                second: { '-1': '刚才', '0': '现在', '1': '即刻' },
                minute: { '-1': '1分钟前', '0': '这一分钟', '1': '1分钟后' },
                hour: { '-1': '1小时前', '0': '这一小时', '1': '1小时后' },
                day: { '-1': '昨天', '0': '今天', '1': '明天' },
                week: { '-1': '上周', '0': '本周', '1': '下周' },
                month: { '-1': '上个月', '0': '本月', '1': '下个月' },
                year: { '-1': '去年', '0': '今年', '1': '明年' }
            }
        }
    },
    en: {
        currency: {
            USD: 'US Dollar', EUR: 'Euro', GBP: 'British Pound', CNY: 'Chinese Yuan',
            JPY: 'Japanese Yen', KRW: 'Korean Won', TWD: 'Taiwan Dollar', HKD: 'Hong Kong Dollar'
        },
        currencySymbol: {
            USD: '$', EUR: '€', GBP: '£', CNY: '¥',
            JPY: '¥', KRW: '₩', TWD: 'NT$', HKD: 'HK$'
        },
        months: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
        monthsShort: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
        weekdays: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
        weekdaysShort: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
        weekdaysNarrow: ['S', 'M', 'T', 'W', 'T', 'F', 'S'],
        relativeTime: {
            future: 'in {0}',
            past: '{0} ago',
            units: {
                second: { one: '{0} second', other: '{0} seconds' },
                minute: { one: '{0} minute', other: '{0} minutes' },
                hour: { one: '{0} hour', other: '{0} hours' },
                day: { one: '{0} day', other: '{0} days' },
                week: { one: '{0} week', other: '{0} weeks' },
                month: { one: '{0} month', other: '{0} months' },
                year: { one: '{0} year', other: '{0} years' }
            },
            auto: {
                second: { '-1': 'just now', '0': 'now', '1': 'in a moment' },
                minute: { '-1': '1 minute ago', '0': 'this minute', '1': 'in 1 minute' },
                hour: { '-1': '1 hour ago', '0': 'this hour', '1': 'in 1 hour' },
                day: { '-1': 'yesterday', '0': 'today', '1': 'tomorrow' },
                week: { '-1': 'last week', '0': 'this week', '1': 'next week' },
                month: { '-1': 'last month', '0': 'this month', '1': 'next month' },
                year: { '-1': 'last year', '0': 'this year', '1': 'next year' }
            }
        }
    }
};

// ============ NumberFormat ============
class NumberFormat implements Intl.NumberFormat {
    private locale: string;
    private options: Intl.NumberFormatOptions;
    private data: typeof localeData.zh | typeof localeData.en;

    static supportedLocalesOf(locales: string | string[], options?: Intl.NumberFormatOptions): string[] {
        return Collator.supportedLocalesOf(locales);
    }

    constructor(locale?: string | string[], options?: Intl.NumberFormatOptions) {
        this.locale = Array.isArray(locale) ? locale[0] : (locale || 'en-US');
        this.options = { style: 'decimal', useGrouping: true, ...options };
        
        const lang = this.locale.startsWith('zh') ? 'zh' : 'en';
        this.data = localeData[lang];
    }

    format(num: number): string {
        const { style = 'decimal' } = this.options;
        
        if (style === 'percent') return this.formatPercent(num);
        if (style === 'currency') return this.formatCurrency(num);
        return this.formatDecimal(num);
    }

    private formatDecimal(num: number): string {
        const { minimumFractionDigits = 0, maximumFractionDigits = 3, useGrouping = true } = this.options;
        
        let result = num.toFixed(maximumFractionDigits);
        result = parseFloat(result).toString();
        
        const parts = result.split('.');
        if (parts[1]) {
            parts[1] = parts[1].padEnd(minimumFractionDigits, '0');
            result = parts.join('.');
        } else if (minimumFractionDigits > 0) {
            result += '.' + '0'.repeat(minimumFractionDigits);
        }
        
        if (useGrouping) {
            const p = result.split('.');
            p[0] = p[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
            result = p.join('.');
        }
        
        return result;
    }

    private formatCurrency(num: number): string {
        const currency = this.options.currency || 'USD';
        const symbol = this.data.currencySymbol[currency as CurrencyCode] || currency;
        return `${symbol}${this.formatDecimal(num)}`;
    }

    private formatPercent(num: number): string {
        return `${this.formatDecimal(num * 100)}%`;
    }

    formatToParts(num: number): Intl.NumberFormatPart[] {
        const formatted = this.format(num);
        return [{ type: 'integer', value: formatted }];
    }

    formatRange(start: number, end: number): string {
        return `${this.format(start)}-${this.format(end)}`;
    }

    formatRangeToParts(start: number, end: number): Intl.NumberRangeFormatPart[] {
        return [
            { type: 'integer', value: this.format(start), source: 'startRange' },
            { type: 'literal', value: '-', source: 'shared' },
            { type: 'integer', value: this.format(end), source: 'endRange' }
        ];
    }

    resolvedOptions(): Intl.ResolvedNumberFormatOptions {
        return {
            locale: this.locale,
            numberingSystem: 'latn',
            style: this.options.style || 'decimal',
            minimumFractionDigits: this.options.minimumFractionDigits || 0,
            maximumFractionDigits: this.options.maximumFractionDigits || 3,
            useGrouping: this.options.useGrouping !== false
        } as Intl.ResolvedNumberFormatOptions;
    }
}

// ============ DateTimeFormat ============
class DateTimeFormat implements Intl.DateTimeFormat {
    private locale: string;
    private options: Intl.DateTimeFormatOptions;
    private data: typeof localeData.zh | typeof localeData.en;

    constructor(locale?: string | string[], options?: Intl.DateTimeFormatOptions) {
        this.locale = Array.isArray(locale) ? locale[0] : (locale || 'en-US');
        this.options = options || {};
        
        const lang = this.locale.startsWith('zh') ? 'zh' : 'en';
        this.data = localeData[lang];
    }

    format(date: Date | number): string {
        const d = typeof date === 'number' ? new Date(date) : date;
        const parts: string[] = [];
        
        if (this.options.year) {
            parts.push(this.locale.startsWith('zh') ? `${d.getFullYear()}年` : d.getFullYear().toString());
        }
        
        if (this.options.month) {
            const month = d.getMonth();
            if (this.options.month === 'long') {
                parts.push(this.data.months[month]);
            } else if (this.options.month === 'short') {
                parts.push(this.data.monthsShort[month]);
            } else {
                parts.push(this.locale.startsWith('zh') ? `${month + 1}月` : (month + 1).toString());
            }
        }
        
        if (this.options.day) {
            parts.push(this.locale.startsWith('zh') ? `${d.getDate()}日` : d.getDate().toString());
        }
        
        if (this.options.weekday) {
            const weekday = d.getDay();
            if (this.options.weekday === 'long') parts.push(this.data.weekdays[weekday]);
            else if (this.options.weekday === 'short') parts.push(this.data.weekdaysShort[weekday]);
            else parts.push(this.data.weekdaysNarrow[weekday]);
        }
        
        return this.locale.startsWith('zh') ? parts.join('') : parts.join(' ') || d.toISOString();
    }

    formatToParts(date: Date | number): Intl.DateTimeFormatPart[] {
        const formatted = this.format(date);
        return [{ type: 'literal', value: formatted }];
    }

    formatRange(start: Date | number, end: Date | number): string {
        return `${this.format(start)} - ${this.format(end)}`;
    }

    formatRangeToParts(start: Date | number, end: Date | number): Intl.DateTimeRangeFormatPart[] {
        return [
            { type: 'literal', value: this.format(start), source: 'startRange' },
            { type: 'literal', value: ' - ', source: 'shared' },
            { type: 'literal', value: this.format(end), source: 'endRange' }
        ];
    }

    resolvedOptions(): Intl.ResolvedDateTimeFormatOptions {
        return {
            locale: this.locale,
            calendar: 'gregory',
            numberingSystem: 'latn',
            timeZone: 'UTC',
            ...this.options
        } as Intl.ResolvedDateTimeFormatOptions;
    }
}

// ============ RelativeTimeFormat ============
class RelativeTimeFormat implements Intl.RelativeTimeFormat {
    private locale: string;
    private options: Intl.RelativeTimeFormatOptions;
    private data: typeof localeData.zh | typeof localeData.en;

    constructor(locale?: string | string[], options?: Intl.RelativeTimeFormatOptions) {
        this.locale = Array.isArray(locale) ? locale[0] : (locale || 'en-US');
        this.options = { numeric: 'always', style: 'long', ...options };
        
        const lang = this.locale.startsWith('zh') ? 'zh' : 'en';
        this.data = localeData[lang];
    }

    format(value: number, unit: Intl.RelativeTimeFormatUnit): string {
        const rtData = this.data.relativeTime;
        
        // Auto mode for special cases
        if (this.options.numeric === 'auto' && Math.abs(value) <= 1) {
            // @ts-ignore
            const autoText = rtData.auto[unit as TimeUnit]?.[value.toString()];
            if (autoText) return autoText;
        }
        
        const absValue = Math.abs(value);
        const unitData = rtData.units[unit as TimeUnit];
        const unitText = absValue === 1 ? unitData.one : unitData.other;
        const formatted = unitText.replace('{0}', absValue.toString());
        
        if (value === 0) return formatted;
        
        const template = value > 0 ? rtData.future : rtData.past;
        return template.replace('{0}', formatted);
    }

    formatToParts(value: number, unit: Intl.RelativeTimeFormatUnit): Intl.RelativeTimeFormatPart[] {
        const formatted = this.format(value, unit);
        return [{ type: 'literal', value: formatted }];
    }

    resolvedOptions(): Intl.ResolvedRelativeTimeFormatOptions {
        return {
            locale: this.locale,
            numeric: this.options.numeric || 'always',
            style: this.options.style || 'long',
            numberingSystem: 'latn'
        };
    }
}

// ============ DisplayNames ============
class DisplayNames implements Intl.DisplayNames {
    private locale: string;
    private type: Intl.DisplayNamesType;
    private data: typeof localeData.zh | typeof localeData.en;

    constructor(locale?: string | string[], options?: Intl.DisplayNamesOptions) {
        this.locale = Array.isArray(locale) ? locale[0] : (locale || 'en-US');
        this.type = options?.type || 'language';
        
        const lang = this.locale.startsWith('zh') ? 'zh' : 'en';
        this.data = localeData[lang];
    }

    of(code: string): string | undefined {
        if (this.type === 'currency') {
            return this.data.currency[code as CurrencyCode];
        }
        return code;
    }

    resolvedOptions(): Intl.ResolvedDisplayNamesOptions {
        return {
            locale: this.locale,
            style: 'long',
            type: this.type,
            fallback: 'code'
        };
    }
}

// ============ Collator ============
class Collator implements Intl.Collator {
    constructor(locales?: Intl.LocalesArgument, options?: Intl.CollatorOptions) {}

    static supportedLocalesOf(_locales: string | string[]): string[] {
        return ['zh', 'zh-CN', 'zh-TW', 'en', 'en-US', 'en-GB'].filter(loc => _locales.includes(loc));
    }
    
    compare: (x: string, y: string) => number = (a, b) => a.localeCompare(b);
    
    resolvedOptions(): Intl.ResolvedCollatorOptions {
        return {
            locale: 'en-US',
            usage: 'sort',
            sensitivity: 'variant',
            ignorePunctuation: false,
            collation: 'default',
            numeric: false,
            caseFirst: 'false',
        };
    }
}

// ============ PluralRules ============
class PluralRules implements Intl.PluralRules {
    constructor(_locale?: string | string[], _options?: Intl.PluralRulesOptions) {}
    
    select(n: number): Intl.LDMLPluralRule {
        return n === 1 ? 'one' : 'other';
    }
    
    selectRange(start: number, end: number): Intl.LDMLPluralRule {
        return this.select(end);
    }
    
    resolvedOptions(): Intl.ResolvedPluralRulesOptions {
        return {
            locale: 'en-US',
            type: 'cardinal',
            minimumIntegerDigits: 1,
            minimumFractionDigits: 0,
            maximumFractionDigits: 3,
            pluralCategories: ['one', 'other']
        };
    }
}

// ============ Locale ============
class Locale implements Intl.Locale {
    baseName: string;
    language: string;
    
    constructor(tag: string) {
        this.baseName = tag;
        this.language = tag.split('-')[0];
    }
    
    toString(): string {
        return this.baseName;
    }
    
    maximize(): Intl.Locale {
        return this;
    }
    
    minimize(): Intl.Locale {
        return this;
    }
}

// ============ ListFormat ============
class ListFormat implements Intl.ListFormat {
    private locale: string;
    
    constructor(locale?: string | string[], _options?: Intl.ListFormatOptions) {
        this.locale = Array.isArray(locale) ? locale[0] : (locale || 'en-US');
    }
    
    format(list: Iterable<string>): string {
        const arr = Array.from(list);
        if (arr.length === 0) return '';
        if (arr.length === 1) return arr[0];
        if (arr.length === 2) return arr.join(this.locale.startsWith('zh') ? '和' : ' and ');
        
        const last = arr[arr.length - 1];
        const rest = arr.slice(0, -1).join(this.locale.startsWith('zh') ? '、' : ', ');
        return rest + (this.locale.startsWith('zh') ? '和' : ', and ') + last;
    }
    
    formatToParts(list: Iterable<string>): { type: "element" | "literal"; value: string; }[] {
        const formatted = this.format(list);
        return [{ type: 'element', value: formatted }];
    }
    
    resolvedOptions(): Intl.ResolvedListFormatOptions {
        return {
            locale: this.locale,
            type: 'conjunction',
            style: 'long'
        };
    }
}

// ============ Segmenter ============
class Segmenter implements Intl.Segmenter {
    constructor(_locale?: string | string[], _options?: Intl.SegmenterOptions) {}
    
    segment(text: string): Intl.Segments {
        const segments: Intl.SegmentData[] = [];
        for (let i = 0; i < text.length; i++) {
            segments.push({ segment: text[i], index: i, input: text, isWordLike: /\w/.test(text[i]) });
        }
        
        return {
            containing(index: number): Intl.SegmentData | undefined {
                return segments[index];
            },
            [Symbol.iterator]: function* () {
                yield* segments;
            }
        } as Intl.Segments;
    }
    
    resolvedOptions(): Intl.ResolvedSegmenterOptions {
        return {
            locale: 'en-US',
            granularity: 'grapheme'
        };
    }
}

// ============ Main Intl Object ============
export class CustomIntl {
    NumberFormat = NumberFormat;
    DateTimeFormat = DateTimeFormat;
    RelativeTimeFormat = RelativeTimeFormat;
    DisplayNames = DisplayNames;
    Collator = Collator as Intl.CollatorConstructor;
    PluralRules = PluralRules;
    Locale = Locale;
    ListFormat = ListFormat;
    Segmenter = Segmenter;

    getCanonicalLocales(locales: string | string[]): string[] {
        const input = Array.isArray(locales) ? locales : [locales];
        return input.filter(loc => loc.startsWith('zh') || loc.startsWith('en'));
    }
    
    supportedValuesOf(_key: string): string[] {
        return ['zh', 'zh-CN', 'zh-TW', 'en', 'en-US', 'en-GB'];
    }
}

Reflect.set(globalThis, 'Intl', new CustomIntl());
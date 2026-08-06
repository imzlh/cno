// complete-intl.ts

type CurrencyCode = 'USD' | 'EUR' | 'GBP' | 'CNY' | 'JPY' | 'KRW' | 'TWD' | 'HKD';
type TimeUnit = 'second' | 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year';
const SUPPORTED_LOCALES = ['zh', 'zh-CN', 'zh-TW', 'en', 'en-US', 'en-GB'] as const;
const RELATIVE_TIME_UNITS = new Set<TimeUnit>(['second', 'minute', 'hour', 'day', 'week', 'month', 'year']);

function canonicalizeLocale(locale: string): string {
    const parts = String(locale).replace(/_/g, '-').split('-').filter(Boolean);
    if (parts.length === 0) return '';
    return parts.map((part, index) => {
        if (index === 0) return part.toLowerCase();
        if (part.length === 2) return part.toUpperCase();
        if (part.length === 4) return part[0].toUpperCase() + part.slice(1).toLowerCase();
        return part.toLowerCase();
    }).join('-');
}

function normalizeLocale(locale?: Intl.LocalesArgument): string {
    const first = Array.isArray(locale) ? locale[0] : locale;
    const normalized = first ? canonicalizeLocale(first) : 'en-US';
    if (!normalized) return 'en-US';
    if (SUPPORTED_LOCALES.includes(normalized as (typeof SUPPORTED_LOCALES)[number])) return normalized;
    if (normalized.startsWith('zh')) return 'zh-CN';
    if (normalized.startsWith('en')) return 'en-US';
    return normalized;
}

function normalizeRelativeTimeUnit(unit: Intl.RelativeTimeFormatUnit): TimeUnit {
    const singular = unit.endsWith('s') ? unit.slice(0, -1) : unit;
    if (RELATIVE_TIME_UNITS.has(singular as TimeUnit)) return singular as TimeUnit;
    throw new RangeError(`Invalid relative time unit: ${unit}`);
}

function supportedLocalesOf(locales: string | string[]): string[] {
    const input = Array.isArray(locales) ? locales : [locales];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const locale of input) {
        const normalized = canonicalizeLocale(locale);
        if (!SUPPORTED_LOCALES.includes(normalized as (typeof SUPPORTED_LOCALES)[number])) continue;
        if (seen.has(normalized)) continue;
        seen.add(normalized);
        out.push(normalized);
    }
    return out;
}

// ============ Time zone resolution ============
// cno ships no IANA tz database, so only zones whose offset is a CONSTANT for all
// instants can be honoured correctly. Everything else throws RangeError rather than
// silently formatting in the host zone (a wrong answer that looks right).
// Supported: UTC + aliases, Etc/GMT{+0..+12,-0..-14} (POSIX sign inversion), and
// offset literals +HH:MM / +HHMM / +HH. Named IANA zones (America/New_York, ...) throw.

const UTC_ALIASES = new Set<string>([
    'utc', 'etc/utc', 'uct', 'etc/uct', 'universal', 'etc/universal',
    'zulu', 'etc/zulu', 'gmt', 'etc/gmt', 'gmt0', 'etc/gmt0',
    'gmt+0', 'etc/gmt+0', 'gmt-0', 'etc/gmt-0',
    'greenwich', 'etc/greenwich',
]);

type ZoneRef =
    | { kind: 'local' }
    | { kind: 'fixed'; offsetMinutes: number; name: string };

function pad2(n: number): string {
    return n < 10 ? '0' + n : String(n);
}

/** Render a minutes-east-of-UTC offset as a canonical `+HH:MM` zone name. */
function offsetToZoneName(offsetMinutes: number): string {
    if (offsetMinutes === 0) return 'UTC';
    return offsetLiteralName(offsetMinutes);
}

/**
 * Canonical spelling of an offset literal. Always `+HH:MM`/`-HH:MM`, never 'UTC':
 * node reports an explicit `+00:00` (and `-00:00`) back as `+00:00`, so keeping the
 * literal form is what round-trips.
 */
function offsetLiteralName(offsetMinutes: number): string {
    const sign = offsetMinutes < 0 ? '-' : '+';
    const abs = Math.abs(offsetMinutes);
    return sign + pad2(Math.floor(abs / 60)) + ':' + pad2(abs % 60);
}

/** Parse `+HH:MM` / `+HHMM` / `+HH`. Returns minutes east of UTC, or null. */
function parseOffsetLiteral(input: string): number | null {
    const m = /^([+-])([0-9]{2})(?::?([0-9]{2}))?$/.exec(input);
    if (!m) return null;
    const hours = Number(m[2]);
    const minutes = m[3] === undefined ? 0 : Number(m[3]);
    // node accepts up to +-23:59 and rejects +24:00 / +99:00 (OBSERVED v24.18.0)
    if (hours > 23 || minutes > 59) return null;
    const total = hours * 60 + minutes;
    return m[1] === '-' ? -total : total;
}

/** Parse `Etc/GMT+N` / `Etc/GMT-N`. POSIX sign is INVERTED: Etc/GMT+5 is UTC-5. */
function parseEtcGmt(lower: string): number | null {
    const m = /^(?:etc\/)?gmt([+-])([0-9]{1,2})$/.exec(lower);
    if (!m) return null;
    const n = Number(m[2]);
    // node's real tzdata range is asymmetric: +0..+12 but -0..-14 (OBSERVED)
    if (m[1] === '+' ? n > 12 : n > 14) return null;
    // sign inversion
    return m[1] === '+' ? -n * 60 : n * 60;
}

function unsupportedZone(raw: string): never {
    throw new RangeError(
        'Invalid time zone specified: ' + raw +
        " (cno has no IANA tz database; use 'UTC', 'Etc/GMT±N', or a fixed offset like '-05:00')",
    );
}

function resolveTimeZone(tz: unknown): ZoneRef {
    if (tz === undefined) return { kind: 'local' };
    const raw = String(tz);
    const lower = raw.toLowerCase();
    if (UTC_ALIASES.has(lower)) return { kind: 'fixed', offsetMinutes: 0, name: 'UTC' };

    const etc = parseEtcGmt(lower);
    if (etc !== null) {
        // canonical form keeps the tzdata spelling, e.g. Etc/GMT+5
        const m = /^(?:etc\/)?gmt([+-])([0-9]{1,2})$/.exec(lower)!;
        return { kind: 'fixed', offsetMinutes: etc, name: 'Etc/GMT' + m[1] + Number(m[2]) };
    }

    const lit = parseOffsetLiteral(raw);
    if (lit !== null) {
        return { kind: 'fixed', offsetMinutes: lit, name: offsetLiteralName(lit) };
    }

    unsupportedZone(raw);
}

/**
 * The zone name to report for the host zone. cno cannot learn the host's IANA name
 * (TZ unset, no tzdata, no native API), so report the actual current offset, which is
 * truthful and round-trips through resolveTimeZone(). Prefer TZ when it names a zone
 * we can actually honour.
 */
function hostZoneName(): string {
    try {
        const tz = (globalThis as { process?: { env?: Record<string, string | undefined> } })
            .process?.env?.TZ;
        if (tz) {
            const lower = tz.toLowerCase();
            if (UTC_ALIASES.has(lower) || parseEtcGmt(lower) !== null || parseOffsetLiteral(tz) !== null) {
                return resolveTimeZone(tz).kind === 'fixed'
                    ? (resolveTimeZone(tz) as { name: string }).name
                    : 'UTC';
            }
        }
    } catch {
        /* process may not exist in every realm */
    }
    return offsetToZoneName(-new Date().getTimezoneOffset());
}

interface DateFields {
    year: number;
    month: number; // 1-12
    day: number;
    weekday: number; // 0=Sunday
    hour: number;
    minute: number;
    second: number;
    millisecond: number;
}

/**
 * Break an epoch time into calendar fields for `zone`.
 * - fixed zone: shift the epoch and read UTC getters. Exact, no tz data needed.
 * - local zone: use the engine's own local getters, so this is exactly as correct as
 *   `date.getHours()` in the same runtime (which on Windows is bounded by
 *   quickjs.c getTimezoneOffset() ignoring its `time` argument).
 */
function dateFieldsFor(time: number, zone: ZoneRef): DateFields {
    if (zone.kind === 'fixed') {
        const shifted = new Date(time + zone.offsetMinutes * 60000);
        const y = shifted.getUTCFullYear();
        if (!Number.isFinite(y)) throw new RangeError('Invalid time value');
        return {
            year: y,
            month: shifted.getUTCMonth() + 1,
            day: shifted.getUTCDate(),
            weekday: shifted.getUTCDay(),
            hour: shifted.getUTCHours(),
            minute: shifted.getUTCMinutes(),
            second: shifted.getUTCSeconds(),
            millisecond: shifted.getUTCMilliseconds(),
        };
    }
    const d = new Date(time);
    return {
        year: d.getFullYear(),
        month: d.getMonth() + 1,
        day: d.getDate(),
        weekday: d.getDay(),
        hour: d.getHours(),
        minute: d.getMinutes(),
        second: d.getSeconds(),
        millisecond: d.getMilliseconds(),
    };
}

/** Offset actually in effect for `zone` at `time`, in minutes east of UTC. */
function zoneOffsetAt(time: number, zone: ZoneRef): number {
    return zone.kind === 'fixed' ? zone.offsetMinutes : -new Date(time).getTimezoneOffset();
}

// ============ Root collation (no CLDR needed) ============
// Uses NFD + combining-mark stripping for the primary key, so German/French/Spanish
// diacritics sort next to their base letter instead of after 'z'. This is DUCET-shaped
// root collation, NOT locale-tailored: sv/da (where 'a-umlaut' sorts AFTER z) are wrong
// by design, and stated as such.

// Combining-mark test by NUMERIC code point. Deliberately not a regex character class:
// raw combining bytes in a literal make `file` classify the source as binary `data`,
// and \uXXXX escapes get normalised back to raw bytes by some editors.
function isCombiningMark(cp: number): boolean {
    return (cp >= 0x0300 && cp <= 0x036f) // Combining Diacritical Marks
        || (cp >= 0x1ab0 && cp <= 0x1aff) // Combining Diacritical Marks Extended
        || (cp >= 0x1dc0 && cp <= 0x1dff) // Combining Diacritical Marks Supplement
        || (cp >= 0x20d0 && cp <= 0x20f0) // Combining Diacritical Marks for Symbols
        || (cp >= 0xfe20 && cp <= 0xfe2f); // Combining Half Marks
}

function stripCombiningMarks(s: string): string {
    let out = '';
    for (let i = 0; i < s.length; i++) {
        if (!isCombiningMark(s.charCodeAt(i))) out += s[i];
    }
    return out;
}

function decompose(s: string): string {
    try {
        return s.normalize('NFD');
    } catch {
        return s;
    }
}

/** Primary key: base letters only, case- and accent-folded. */
function primaryKey(s: string): string {
    return stripCombiningMarks(decompose(s)).toLowerCase();
}

/** Secondary key: accents retained, case folded. */
function secondaryKey(s: string): string {
    return decompose(s).toLowerCase();
}

function codepointCompare(a: string, b: string): number {
    if (a === b) return 0;
    return a < b ? -1 : 1;
}

/** Split into runs of digits / non-digits for numeric-aware comparison. */
function numericChunks(s: string): string[] {
    return s.match(/[0-9]+|[^0-9]+/g) ?? [];
}

function numericCompare(a: string, b: string, base: (x: string, y: string) => number): number {
    const ca = numericChunks(a);
    const cb = numericChunks(b);
    const n = Math.min(ca.length, cb.length);
    for (let i = 0; i < n; i++) {
        const x = ca[i];
        const y = cb[i];
        const xNum = /^[0-9]+$/.test(x);
        const yNum = /^[0-9]+$/.test(y);
        if (xNum && yNum) {
            const dx = Number(x);
            const dy = Number(y);
            if (dx !== dy) return dx < dy ? -1 : 1;
            continue;
        }
        const r = base(x, y);
        if (r !== 0) return r;
    }
    if (ca.length !== cb.length) return ca.length < cb.length ? -1 : 1;
    return 0;
}

/** ASCII punctuation and whitespace, for `ignorePunctuation`. By code point rather
 * than a character class, to keep this source free of raw non-ASCII regex bytes. */
function isPunctuationOrSpace(cp: number): boolean {
    return (cp >= 0x21 && cp <= 0x2f) || (cp >= 0x3a && cp <= 0x40)
        || (cp >= 0x5b && cp <= 0x60) || (cp >= 0x7b && cp <= 0x7e)
        || cp === 0x20 || cp === 0x09 || cp === 0x0a || cp === 0x0d;
}

function stripPunctuation(s: string): string {
    let out = '';
    for (let i = 0; i < s.length; i++) {
        if (!isPunctuationOrSpace(s.charCodeAt(i))) out += s[i];
    }
    return out;
}

/** Tertiary level: lowercase sorts before uppercase (OBSERVED node: 'a' < 'A').
 * Combining marks are stripped first, so this level carries case only -- accents
 * belong to the secondary level, and sensitivity 'case' must ignore them. */
function caseCompare(a: string, b: string): number {
    const da = stripCombiningMarks(decompose(a));
    const db = stripCombiningMarks(decompose(b));
    const n = Math.min(da.length, db.length);
    for (let i = 0; i < n; i++) {
        if (da[i] === db[i]) continue;
        const aLower = da[i].toLowerCase() === da[i];
        const bLower = db[i].toLowerCase() === db[i];
        if (aLower !== bLower) return aLower ? -1 : 1;
    }
    if (da.length !== db.length) return da.length < db.length ? -1 : 1;
    return 0;
}

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
        monthsNarrow: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'],
        // [BC, AD]; zh uses the same string for all three widths (OBSERVED node)
        eras: { long: ['公元前', '公元'], short: ['公元前', '公元'], narrow: ['公元前', '公元'] },
        dayPeriods: ['上午', '下午'],
        utcLong: '协调世界时',
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
        monthsNarrow: ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'],
        // [BC, AD] (OBSERVED node en-US)
        eras: { long: ['Before Christ', 'Anno Domini'], short: ['BC', 'AD'], narrow: ['B', 'A'] },
        dayPeriods: ['AM', 'PM'],
        utcLong: 'Coordinated Universal Time',
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

// ============ Decimal number core ============
// Rounding runs on the value's shortest round-trip DECIMAL string, not on toFixed().
// (1.005).toFixed(2) is "1.00" because the double is 1.00499999999999989, but ICU
// rounds the decimal literal and prints "1.01". OBSERVED node: 1.005 @maxFrac2 -> "1.01".

/** ISO 4217 minor-unit counts that are not the default 2. */
const CURRENCY_MINOR_0 = new Set<string>([
    'BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW', 'PYG', 'RWF',
    'UGX', 'UYI', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
]);
const CURRENCY_MINOR_3 = new Set<string>(['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND']);

/** U+00A0. Built by code point so this source file stays pure ASCII. */
const NBSP = String.fromCharCode(0xa0);
/** U+2009 THIN SPACE and U+2013 EN DASH, as used by node's formatRange. */
const THIN_SPACE = String.fromCharCode(0x2009);
const EN_DASH = String.fromCharCode(0x2013);

function currencyMinorUnits(code: string): number {
    const upper = String(code).toUpperCase();
    if (CURRENCY_MINOR_0.has(upper)) return 0;
    if (CURRENCY_MINOR_3.has(upper)) return 3;
    return 2;
}

interface Decimal {
    neg: boolean;
    int: string; // integer digits, no sign, no separators; at least "0"
    frac: string; // fraction digits, no point
}

/** Parse a non-negative decimal or exponential digit string into a plain Decimal. */
function parsePlainDecimal(neg: boolean, s: string): Decimal {
    const e = s.indexOf('e');
    if (e < 0) {
        const dot = s.indexOf('.');
        if (dot < 0) return { neg, int: s, frac: '' };
        return { neg, int: s.slice(0, dot), frac: s.slice(dot + 1) };
    }
    const mant = s.slice(0, e);
    const exp = Number(s.slice(e + 1));
    const dot = mant.indexOf('.');
    const digits = dot < 0 ? mant : mant.slice(0, dot) + mant.slice(dot + 1);
    const pointPos = (dot < 0 ? mant.length : dot) + exp;
    if (pointPos <= 0) return { neg, int: '0', frac: '0'.repeat(-pointPos) + digits };
    if (pointPos >= digits.length) {
        return { neg, int: digits + '0'.repeat(pointPos - digits.length), frac: '' };
    }
    return { neg, int: digits.slice(0, pointPos), frac: digits.slice(pointPos) };
}

function decimalFromNumber(value: number): Decimal {
    const neg = value < 0 || Object.is(value, -0);
    return parsePlainDecimal(neg, Math.abs(value).toString());
}

function decimalFromBigInt(value: bigint): Decimal {
    const s = value.toString();
    return s.charCodeAt(0) === 45 /* '-' */
        ? { neg: true, int: s.slice(1), frac: '' }
        : { neg: false, int: s, frac: '' };
}

/** Add 1 to a digit string, growing it on carry-out. */
function incrementDigits(s: string): string {
    const a = s.split('');
    let i = a.length - 1;
    for (; i >= 0; i--) {
        if (a[i] === '9') {
            a[i] = '0';
        } else {
            a[i] = String.fromCharCode(a[i].charCodeAt(0) + 1);
            break;
        }
    }
    return i < 0 ? '1' + a.join('') : a.join('');
}

/** Move the decimal point `places` digits to the right (for percent: 2). */
function shiftDecimal(d: Decimal, places: number): Decimal {
    if (places <= 0) return d;
    const padded = d.frac + '0'.repeat(Math.max(0, places - d.frac.length));
    const moved = padded.slice(0, places);
    const int = (d.int + moved).replace(/^0+(?=[0-9])/, '');
    return { neg: d.neg, int, frac: padded.slice(places) };
}

/** Round to at most `maxFrac` fraction digits, half away from zero (halfExpand). */
function roundDecimal(d: Decimal, maxFrac: number): Decimal {
    if (d.frac.length <= maxFrac) return d;
    let digits = d.int + d.frac.slice(0, maxFrac);
    if (d.frac.charCodeAt(maxFrac) - 48 >= 5) digits = incrementDigits(digits);
    const cut = digits.length - maxFrac;
    return { neg: d.neg, int: digits.slice(0, cut) || '0', frac: digits.slice(cut) };
}

/** Clamp the fraction to [minFrac, maxFrac], dropping trailing zeros above minFrac. */
function clampFraction(d: Decimal, minFrac: number, maxFrac: number): Decimal {
    const r = roundDecimal(d, maxFrac);
    let frac = r.frac;
    while (frac.length > minFrac && frac.charCodeAt(frac.length - 1) === 48 /* '0' */) {
        frac = frac.slice(0, -1);
    }
    if (frac.length < minFrac) frac += '0'.repeat(minFrac - frac.length);
    return { neg: r.neg, int: r.int, frac };
}

/** Split integer digits into 3-digit groups (en and zh both group by 3). */
function groupInteger(int: string): string[] {
    const groups: string[] = [];
    let end = int.length;
    while (end > 3) {
        groups.unshift(int.slice(end - 3, end));
        end -= 3;
    }
    groups.unshift(int.slice(0, end));
    return groups;
}

// ============ NumberFormat ============
class NumberFormat implements Intl.NumberFormat {
    private locale: string;
    private options: Intl.NumberFormatOptions;
    private data: typeof localeData.zh | typeof localeData.en;
    private style: string;
    private minFrac: number;
    private maxFrac: number;
    private minInt: number;
    private maxSig: number | undefined;
    private boundFormat: ((value: number | bigint) => string) | undefined;

    static supportedLocalesOf(locales: string | string[], options?: Intl.NumberFormatOptions): string[] {
        return supportedLocalesOf(locales);
    }

    constructor(locale?: string | string[], options?: Intl.NumberFormatOptions) {
        this.locale = normalizeLocale(locale);
        this.options = { style: 'decimal', ...options };
        const lang = this.locale.startsWith('zh') ? 'zh' : 'en';
        this.data = localeData[lang];

        this.style = this.options.style ?? 'decimal';
        // Per-style fraction defaults, OBSERVED from node resolvedOptions():
        // decimal/unit 0..3, percent 0..0, currency n..n where n is the minor-unit count.
        let defMin = 0;
        let defMax = 3;
        if (this.style === 'currency') {
            defMin = currencyMinorUnits(this.options.currency ?? 'USD');
            defMax = defMin;
        } else if (this.style === 'percent') {
            defMax = 0;
        }
        this.minFrac = this.options.minimumFractionDigits ?? defMin;
        this.maxFrac = this.options.maximumFractionDigits ?? Math.max(defMax, this.minFrac);
        if (this.maxFrac < this.minFrac) this.maxFrac = this.minFrac;
        this.minInt = this.options.minimumIntegerDigits ?? 1;
        this.maxSig = this.options.maximumSignificantDigits ?? undefined;
    }

    /** node exposes `format` as a bound accessor, so a detached reference still works. */
    get format(): (value: number | bigint) => string {
        if (!this.boundFormat) this.boundFormat = (value) => this.formatValue(value);
        return this.boundFormat;
    }

    private formatValue(value: number | bigint): string {
        return this.buildParts(value).map((p) => p.value).join('');
    }

    /** Normalise the input to a Decimal, or to a non-finite marker. */
    private toDecimal(value: unknown): Decimal | 'nan' | 'inf' | '-inf' {
        if (typeof value === 'bigint') return decimalFromBigInt(value);
        if (typeof value === 'string') {
            const t = value.trim();
            if (/^[+-]?[0-9]+(?:\.[0-9]+)?$/.test(t)) {
                const first = t.charCodeAt(0);
                const neg = first === 45 /* '-' */;
                return parsePlainDecimal(neg, neg || first === 43 /* '+' */ ? t.slice(1) : t);
            }
            return this.toDecimal(Number(t));
        }
        const n = typeof value === 'number' ? value : Number(value);
        if (Number.isNaN(n)) return 'nan';
        if (n === Infinity) return 'inf';
        if (n === -Infinity) return '-inf';
        return decimalFromNumber(n);
    }

    /** Round to `maxSig` significant digits (maximumSignificantDigits). */
    private applySignificant(d: Decimal, maxSig: number): Decimal {
        const combined = d.int + d.frac;
        const firstSig = combined.search(/[1-9]/);
        if (firstSig < 0) return { neg: d.neg, int: d.int, frac: '' };
        const keepTo = firstSig + maxSig;
        if (keepTo >= combined.length) return d;
        const fracKeep = keepTo - d.int.length;
        if (fracKeep >= 0) return roundDecimal(d, fracKeep);
        let digits = combined.slice(0, keepTo);
        if (combined.charCodeAt(keepTo) - 48 >= 5) digits = incrementDigits(digits);
        return { neg: d.neg, int: digits + '0'.repeat(d.int.length - digits.length), frac: '' };
    }


    /** The whole formatter: one parts builder, with format() joining its output. */
    private buildParts(value: number | bigint): Intl.NumberFormatPart[] {
        const parts: Intl.NumberFormatPart[] = [];
        const sig = this.toDecimal(value);
        const currency = this.options.currency ?? 'USD';
        const display = this.options.currencyDisplay ?? 'symbol';

        if (sig === 'nan' || sig === 'inf' || sig === '-inf') {
            if (sig === '-inf') parts.push({ type: 'minusSign', value: '-' });
            parts.push(sig === 'nan'
                ? { type: 'nan', value: 'NaN' }
                : { type: 'infinity', value: '∞' });
            return parts;
        }

        let d = this.style === 'percent' ? shiftDecimal(sig, 2) : sig;
        d = this.maxSig !== undefined
            ? this.applySignificant(d, this.maxSig)
            : clampFraction(d, this.minFrac, this.maxFrac);

        let int = d.int;
        if (int.length < this.minInt) int = '0'.repeat(this.minInt - int.length) + int;

        const isZero = /^0*$/.test(int) && /^0*$/.test(d.frac);
        const signDisplay = this.options.signDisplay ?? 'auto';
        if (d.neg && signDisplay !== 'never' && !(signDisplay === 'exceptZero' && isZero)) {
            parts.push({ type: 'minusSign', value: '-' });
        } else if (!d.neg && !isZero && (signDisplay === 'always' || signDisplay === 'exceptZero')) {
            parts.push({ type: 'plusSign', value: '+' });
        } else if (!d.neg && isZero && signDisplay === 'always') {
            parts.push({ type: 'plusSign', value: '+' });
        }

        // Currency prefix. An unknown code renders as "CODE 12.50" (OBSERVED node).
        const symbol = this.data.currencySymbol[currency as CurrencyCode];
        if (this.style === 'currency' && display !== 'name') {
            if (display === 'code' || !symbol) {
                parts.push({ type: 'currency', value: String(currency).toUpperCase() });
                // node separates a currency CODE from the number with U+00A0, not a
                // plain space (OBSERVED). Built by code point to keep this source ASCII.
                parts.push({ type: 'literal', value: NBSP });
            } else {
                parts.push({ type: 'currency', value: symbol });
            }
        }

        const grouping = this.options.useGrouping;
        if (grouping === false || grouping === 'false') {
            parts.push({ type: 'integer', value: int });
        } else {
            const groups = groupInteger(int);
            for (let i = 0; i < groups.length; i++) {
                if (i > 0) parts.push({ type: 'group', value: ',' });
                parts.push({ type: 'integer', value: groups[i] });
            }
        }
        if (d.frac.length > 0) {
            parts.push({ type: 'decimal', value: '.' });
            parts.push({ type: 'fraction', value: d.frac });
        }

        if (this.style === 'percent') parts.push({ type: 'percentSign', value: '%' });
        if (this.style === 'currency' && display === 'name') {
            parts.push({ type: 'literal', value: ' ' });
            parts.push({
                type: 'currency',
                value: this.data.currency[currency as CurrencyCode] ?? String(currency).toUpperCase(),
            });
        }
        // No CLDR unit data: emit the unit identifier verbatim rather than drop it.
        if (this.style === 'unit' && this.options.unit) {
            parts.push({ type: 'literal', value: ' ' });
            parts.push({ type: 'unit', value: String(this.options.unit) });
        }
        return parts;
    }

    formatToParts(num: number | bigint): Intl.NumberFormatPart[] {
        return this.buildParts(num);
    }

    formatRange(start: number | bigint, end: number | bigint): string {
        // node joins with an EN DASH, not a hyphen (OBSERVED: "1–5").
        return `${this.formatValue(start)}–${this.formatValue(end)}`;
    }

    formatRangeToParts(start: number | bigint, end: number | bigint): Intl.NumberRangeFormatPart[] {
        const out: Intl.NumberRangeFormatPart[] = [];
        for (const p of this.buildParts(start)) out.push({ ...p, source: 'startRange' });
        out.push({ type: 'literal', value: '–', source: 'shared' });
        for (const p of this.buildParts(end)) out.push({ ...p, source: 'endRange' });
        return out;
    }

    resolvedOptions(): Intl.ResolvedNumberFormatOptions {
        const out: Record<string, unknown> = {
            locale: this.locale,
            numberingSystem: 'latn',
            style: this.style,
        };
        if (this.style === 'currency') {
            out.currency = String(this.options.currency ?? 'USD').toUpperCase();
            out.currencyDisplay = this.options.currencyDisplay ?? 'symbol';
            out.currencySign = this.options.currencySign ?? 'standard';
        }
        if (this.style === 'unit' && this.options.unit) {
            out.unit = this.options.unit;
            out.unitDisplay = this.options.unitDisplay ?? 'short';
        }
        out.minimumIntegerDigits = this.minInt;
        if (this.maxSig === undefined) {
            out.minimumFractionDigits = this.minFrac;
            out.maximumFractionDigits = this.maxFrac;
        } else {
            out.minimumSignificantDigits = this.options.minimumSignificantDigits ?? 1;
            out.maximumSignificantDigits = this.maxSig;
        }
        const grouping = this.options.useGrouping;
        out.useGrouping = grouping === false || grouping === 'false' ? false : (grouping ?? 'auto');
        out.notation = this.options.notation ?? 'standard';
        out.signDisplay = this.options.signDisplay ?? 'auto';
        out.roundingIncrement = 1;
        out.roundingMode = 'halfExpand';
        out.roundingPriority = 'auto';
        out.trailingZeroDisplay = 'auto';
        return out as unknown as Intl.ResolvedNumberFormatOptions;
    }

    get [Symbol.toStringTag]() {
        return 'Intl.NumberFormat';
    }
}

// ============ DateTimeFormat support ============

/**
 * Render a zone offset the way node's `timeZoneName` option does (OBSERVED):
 *   offset 0: short 'UTC', long 'Coordinated Universal Time',
 *             shortOffset 'GMT+0', longOffset 'GMT+00:00'
 *   -300:     short/shortOffset 'GMT-5', long/longOffset 'GMT-05:00'
 *   +330:     short 'GMT+5:30', long 'GMT+05:30'
 */
function zoneDisplayName(offsetMinutes: number, style: string, utcLong: string): string {
    const wide = style === 'long' || style === 'longOffset' || style === 'longGeneric';
    if (offsetMinutes === 0) {
        if (style === 'short' || style === 'shortGeneric') return 'UTC';
        if (style === 'long' || style === 'longGeneric') return utcLong;
        return style === 'longOffset' ? 'GMT+00:00' : 'GMT+0';
    }
    const sign = offsetMinutes < 0 ? '-' : '+';
    const abs = Math.abs(offsetMinutes);
    const h = Math.floor(abs / 60);
    const m = abs % 60;
    if (wide) return 'GMT' + sign + pad2(h) + ':' + pad2(m);
    return 'GMT' + sign + String(h) + (m === 0 ? '' : ':' + pad2(m));
}

/** hour12 beats hourCycle when both are present (OBSERVED node). */
function resolveHourCycle(
    options: { hour12?: boolean; hourCycle?: string },
    localeDefault: string,
): string {
    if (options.hour12 === false) return 'h23';
    if (options.hour12 === true) return 'h12';
    if (options.hourCycle) return options.hourCycle;
    return localeDefault;
}

/** Map a 0-23 hour onto the display value for a cycle. */
function hourForCycle(hour23: number, cycle: string): number {
    if (cycle === 'h11') return hour23 % 12;
    if (cycle === 'h12') return hour23 % 12 === 0 ? 12 : hour23 % 12;
    if (cycle === 'h24') return hour23 === 0 ? 24 : hour23;
    return hour23;
}

function cycleHasDayPeriod(cycle: string): boolean {
    return cycle === 'h11' || cycle === 'h12';
}

interface DTFComponents {
    weekday?: string;
    era?: string;
    year?: string;
    month?: string;
    day?: string;
    dayPeriod?: string;
    hour?: string;
    minute?: string;
    second?: string;
    fractionalSecondDigits?: number;
    timeZoneName?: string;
}

const DATE_KEYS = ['weekday', 'era', 'year', 'month', 'day'] as const;
const TIME_KEYS = ['dayPeriod', 'hour', 'minute', 'second', 'fractionalSecondDigits'] as const;

/**
 * Turn the requested options into a concrete component set.
 * dateStyle/timeStyle expand to the skeletons node uses (OBSERVED); with neither
 * style nor any component present, node defaults to numeric year/month/day.
 */
function expandComponents(options: Intl.DateTimeFormatOptions, isZh: boolean): DTFComponents {
    const out: DTFComponents = {};
    const src = options as unknown as Record<string, unknown>;
    for (const k of DATE_KEYS) if (src[k] !== undefined) (out as Record<string, unknown>)[k] = src[k];
    for (const k of TIME_KEYS) if (src[k] !== undefined) (out as Record<string, unknown>)[k] = src[k];
    if (src.timeZoneName !== undefined) out.timeZoneName = src.timeZoneName as string;

    const ds = options.dateStyle;
    if (ds === 'full') {
        out.weekday = 'long'; out.year = 'numeric'; out.month = 'long'; out.day = 'numeric';
    } else if (ds === 'long') {
        out.year = 'numeric'; out.month = 'long'; out.day = 'numeric';
    } else if (ds === 'medium') {
        out.year = 'numeric'; out.month = 'short'; out.day = 'numeric';
    } else if (ds === 'short') {
        // zh keeps a 4-digit year in the short form; en uses 2 (OBSERVED).
        out.year = isZh ? 'numeric' : '2-digit'; out.month = 'numeric'; out.day = 'numeric';
    }

    const ts = options.timeStyle;
    if (ts) {
        out.hour = 'numeric';
        out.minute = '2-digit';
        if (ts !== 'short') out.second = '2-digit';
        if (ts === 'long') out.timeZoneName = 'short';
        if (ts === 'full') out.timeZoneName = 'long';
    }

    const anyDate = DATE_KEYS.some((k) => out[k] !== undefined);
    const anyTime = TIME_KEYS.some((k) => out[k] !== undefined);
    if (!anyDate && !anyTime && out.timeZoneName === undefined) {
        out.year = 'numeric'; out.month = 'numeric'; out.day = 'numeric';
    } else if (!anyDate && !anyTime) {
        // timeZoneName alone still gets the default date (OBSERVED "3/4/2021, UTC").
        out.year = 'numeric'; out.month = 'numeric'; out.day = 'numeric';
    }
    return out;
}

function hasDateFields(c: DTFComponents): boolean {
    return DATE_KEYS.some((k) => c[k] !== undefined);
}

function hasTimeFields(c: DTFComponents): boolean {
    return TIME_KEYS.some((k) => c[k] !== undefined);
}

// ============ DateTimeFormat ============
class DateTimeFormat implements Intl.DateTimeFormat {
    private locale: string;
    private options: Intl.DateTimeFormatOptions;
    private data: typeof localeData.zh | typeof localeData.en;
    private isZh: boolean;
    private zone: ZoneRef;
    private comp: DTFComponents;
    private cycle: string;
    private boundFormat: ((date?: Date | number) => string) | undefined;

    static supportedLocalesOf(locales: string | string[]): string[] {
        return supportedLocalesOf(locales);
    }

    constructor(locale?: string | string[], options?: Intl.DateTimeFormatOptions) {
        this.locale = normalizeLocale(locale);
        this.options = options || {};
        const lang = this.locale.startsWith('zh') ? 'zh' : 'en';
        this.data = localeData[lang];
        this.isZh = lang === 'zh';
        // Throws RangeError for named IANA zones and unparseable strings, at
        // construction time, which is where node throws too.
        this.zone = resolveTimeZone(this.options.timeZone);
        this.comp = expandComponents(this.options, this.isZh);
        // en defaults to a 12-hour clock, zh to a 24-hour one (OBSERVED).
        this.cycle = resolveHourCycle(this.options, this.isZh ? 'h23' : 'h12');
    }

    /** node exposes `format` as a bound accessor, so a detached reference works. */
    get format(): (date?: Date | number) => string {
        if (!this.boundFormat) this.boundFormat = (date) => this.formatValue(date);
        return this.boundFormat;
    }

    private timeOf(date?: Date | number): number {
        const t = date === undefined
            ? Date.now()
            : typeof date === 'number' ? date : date.getTime();
        if (!Number.isFinite(t)) throw new RangeError('Invalid time value');
        return t;
    }

    /** Numeric field, 2-padded only when the option asks for it. */
    private num(value: number, width: string | undefined): string {
        return width === '2-digit' ? pad2(value) : String(value);
    }

    /** Date half of the pattern. Returns [] when no date fields were requested. */
    private dateParts(f: DateFields): Intl.DateTimeFormatPart[] {
        const c = this.comp;
        const out: Intl.DateTimeFormatPart[] = [];
        if (!hasDateFields(c)) return out;

        // Era applies to the displayed year: astronomical year 0 is 1 BC, so a
        // non-positive year prints (1 - year) with the BC marker (OBSERVED node).
        const isBc = f.year <= 0;
        const displayYear = isBc ? 1 - f.year : f.year;
        const eraWidth = (c.era === 'long' || c.era === 'narrow' ? c.era : 'short') as 'long' | 'short' | 'narrow';
        const eraText = this.data.eras[eraWidth][isBc ? 0 : 1];
        const yearText = c.year === '2-digit' ? pad2(displayYear % 100) : String(displayYear);
        const monthTextual = c.month === 'long' || c.month === 'short' || c.month === 'narrow';
        const push = (type: Intl.DateTimeFormatPartTypes, value: string) => out.push({ type, value });
        const lit = (value: string) => out.push({ type: 'literal', value });

        if (this.isZh) {
            // zh uses the 年/月/日 form whenever a month name or a weekday is present,
            // and a slash form otherwise (OBSERVED).
            const cjk = monthTextual || c.weekday !== undefined;
            if (c.era) push('era', eraText);
            // Slash form needs a numeric month plus at least one of year/day;
            // anything else falls back to the suffixed standalone form (OBSERVED).
            const slash = !cjk && c.month !== undefined && (c.year !== undefined || c.day !== undefined);
            if (!slash) {
                // Standalone/CJK assembly: each field carries its own suffix.
                if (c.year) { push('year', yearText); lit('年'); }
                if (c.month) {
                    // A bare month renders as a name for 'long' and as a plain
                    // number for 'narrow'; every other case takes the 月 suffix.
                    const alone = c.year === undefined && c.day === undefined;
                    if (alone && c.month === 'long') {
                        push('month', this.data.months[f.month - 1]);
                    } else if (alone && c.month === 'narrow') {
                        push('month', this.num(f.month, c.month));
                    } else {
                        push('month', this.num(f.month, c.month));
                        lit('月');
                    }
                }
                if (c.day) { push('day', this.num(f.day, c.day)); lit('日'); }
            } else {
                const seq: Array<[Intl.DateTimeFormatPartTypes, string]> = [];
                if (c.year) seq.push(['year', yearText]);
                if (c.month) seq.push(['month', this.num(f.month, c.month)]);
                if (c.day) seq.push(['day', this.num(f.day, c.day)]);
                for (let i = 0; i < seq.length; i++) {
                    if (i > 0) lit('/');
                    push(seq[i][0], seq[i][1]);
                }
            }
            if (c.weekday) push('weekday', this.weekdayText(f.weekday, c.weekday));
            return out;
        }

        // en assembly.
        if (c.weekday) {
            push('weekday', this.weekdayText(f.weekday, c.weekday));
            if (c.year || c.month || c.day) lit(', ');
        }
        if (monthTextual) {
            push('month', this.monthText(f.month, c.month as string));
            if (c.day) { lit(' '); push('day', this.num(f.day, c.day)); }
            if (c.year) { lit(c.day ? ', ' : ' '); push('year', yearText); }
        } else {
            const seq: Array<[Intl.DateTimeFormatPartTypes, string]> = [];
            if (c.month) seq.push(['month', this.num(f.month, c.month)]);
            if (c.day) seq.push(['day', this.num(f.day, c.day)]);
            if (c.year) seq.push(['year', yearText]);
            for (let i = 0; i < seq.length; i++) {
                if (i > 0) lit('/');
                push(seq[i][0], seq[i][1]);
            }
        }
        if (c.era) { lit(' '); push('era', eraText); }
        return out;
    }

    private monthText(month1: number, width: string): string {
        const i = month1 - 1;
        if (width === 'long') return this.data.months[i];
        if (width === 'short') return this.data.monthsShort[i];
        return this.data.monthsNarrow[i];
    }

    private weekdayText(weekday: number, width: string): string {
        if (width === 'long') return this.data.weekdays[weekday];
        if (width === 'short') return this.data.weekdaysShort[weekday];
        return this.data.weekdaysNarrow[weekday];
    }

    /** Time half of the pattern. Returns [] when no time fields were requested. */
    private timeParts(f: DateFields): Intl.DateTimeFormatPart[] {
        const c = this.comp;
        const out: Intl.DateTimeFormatPart[] = [];
        if (!hasTimeFields(c)) return out;
        const push = (type: Intl.DateTimeFormatPartTypes, value: string) => out.push({ type, value });
        const lit = (value: string) => out.push({ type: 'literal', value });

        const fields: Array<{ t: Intl.DateTimeFormatPartTypes; v: number; w: string | undefined }> = [];
        if (c.hour !== undefined) fields.push({ t: 'hour', v: hourForCycle(f.hour, this.cycle), w: c.hour });
        if (c.minute !== undefined) fields.push({ t: 'minute', v: f.minute, w: c.minute });
        if (c.second !== undefined) fields.push({ t: 'second', v: f.second, w: c.second });

        // A day period shows when the hour cycle has one; with no hour field at all,
        // an explicit dayPeriod option is rendered as AM/PM (see the divergence note).
        const showDp = c.hour !== undefined
            ? cycleHasDayPeriod(this.cycle)
            : c.dayPeriod !== undefined;
        const dpText = this.data.dayPeriods[f.hour < 12 ? 0 : 1];
        if (showDp && this.isZh) push('dayPeriod', dpText);

        for (let i = 0; i < fields.length; i++) {
            if (i > 0) lit(':');
            const fl = fields[i];
            let text: string;
            if (i > 0) {
                text = pad2(fl.v);
            } else if (fl.t === 'hour') {
                // en pads the hour on a 24-hour clock even for 'numeric'; zh does not.
                const pad = fl.w === '2-digit' || (!this.isZh && !cycleHasDayPeriod(this.cycle));
                text = pad ? pad2(fl.v) : String(fl.v);
            } else {
                // A lone minute or second is unpadded even at '2-digit' (OBSERVED).
                text = fields.length > 1 ? pad2(fl.v) : String(fl.v);
            }
            push(fl.t, text);
        }
        // zh marks a bare hour with 时; it drops the marker once minutes follow.
        if (this.isZh && fields.length === 1 && fields[0].t === 'hour') lit('时');

        if (c.fractionalSecondDigits) {
            const n = Math.min(3, Math.max(1, c.fractionalSecondDigits));
            lit('.');
            push('fractionalSecond', String(f.millisecond).padStart(3, '0').slice(0, n));
        }
        if (showDp && !this.isZh) { lit(' '); push('dayPeriod', dpText); }
        return out;
    }

    private formatValue(date?: Date | number): string {
        return this.buildParts(this.timeOf(date)).map((p) => p.value).join('');
    }

    private buildParts(time: number): Intl.DateTimeFormatPart[] {
        const f = dateFieldsFor(time, this.zone);
        const c = this.comp;
        const dateSide = this.dateParts(f);
        const timeSide = this.timeParts(f);
        const out: Intl.DateTimeFormatPart[] = [];

        let tzSide: Intl.DateTimeFormatPart[] = [];
        if (c.timeZoneName) {
            tzSide = [{
                type: 'timeZoneName',
                value: zoneDisplayName(
                    zoneOffsetAt(time, this.zone),
                    c.timeZoneName,
                    this.data.utcLong,
                ),
            }];
        }

        for (const p of dateSide) out.push(p);
        if (dateSide.length > 0 && (timeSide.length > 0 || tzSide.length > 0)) {
            // en joins with " at " for a spelled-out month and ", " otherwise; zh
            // uses a plain space (OBSERVED node).
            out.push({
                type: 'literal',
                value: this.isZh ? ' ' : c.month === 'long' ? ' at ' : ', ',
            });
        }
        // zh puts the zone name before the time, en after it (OBSERVED).
        if (this.isZh && timeSide.length > 0) {
            for (const p of tzSide) out.push(p);
            if (tzSide.length > 0) out.push({ type: 'literal', value: ' ' });
            for (const p of timeSide) out.push(p);
        } else {
            for (const p of timeSide) out.push(p);
            if (timeSide.length > 0 && tzSide.length > 0) {
                out.push({ type: 'literal', value: ' ' });
            }
            for (const p of tzSide) out.push(p);
        }
        return out;
    }

    formatToParts(date?: Date | number): Intl.DateTimeFormatPart[] {
        return this.buildParts(this.timeOf(date));
    }

    formatRange(start: Date | number, end: Date | number): string {
        const a = this.formatValue(start);
        const b = this.formatValue(end);
        // Identical renderings collapse to a single value; the separator is
        // THIN SPACE + EN DASH + THIN SPACE (OBSERVED node).
        return a === b ? a : a + THIN_SPACE + EN_DASH + THIN_SPACE + b;
    }

    formatRangeToParts(start: Date | number, end: Date | number): Intl.DateTimeRangeFormatPart[] {
        const out: Intl.DateTimeRangeFormatPart[] = [];
        const a = this.buildParts(this.timeOf(start));
        const b = this.buildParts(this.timeOf(end));
        const same = a.map((p) => p.value).join('') === b.map((p) => p.value).join('');
        for (const p of a) out.push({ ...p, source: same ? 'shared' : 'startRange' });
        if (same) return out;
        out.push({ type: 'literal', value: THIN_SPACE + EN_DASH + THIN_SPACE, source: 'shared' });
        for (const p of b) out.push({ ...p, source: 'endRange' });
        return out;
    }

    resolvedOptions(): Intl.ResolvedDateTimeFormatOptions {
        const c = this.comp;
        const out: Record<string, unknown> = {
            locale: this.locale,
            calendar: 'gregory',
            numberingSystem: 'latn',
            // The zone actually in use. For the host zone cno reports the current
            // offset (it cannot know the IANA name); the value round-trips through
            // resolveTimeZone(), so feeding it back to the constructor agrees.
            timeZone: this.zone.kind === 'fixed' ? this.zone.name : hostZoneName(),
        };
        if (c.hour !== undefined) {
            out.hourCycle = this.cycle;
            out.hour12 = cycleHasDayPeriod(this.cycle);
        }
        if (this.options.dateStyle || this.options.timeStyle) {
            if (this.options.dateStyle) out.dateStyle = this.options.dateStyle;
            if (this.options.timeStyle) out.timeStyle = this.options.timeStyle;
            return out as unknown as Intl.ResolvedDateTimeFormatOptions;
        }
        for (const k of ['weekday', 'era', 'year', 'month', 'day', 'dayPeriod',
            'hour', 'minute', 'second', 'fractionalSecondDigits', 'timeZoneName'] as const) {
            const v = (c as Record<string, unknown>)[k];
            if (v !== undefined) out[k] = v;
        }
        return out as unknown as Intl.ResolvedDateTimeFormatOptions;
    }

    get [Symbol.toStringTag]() {
        return 'Intl.DateTimeFormat';
    }
}

// ============ RelativeTimeFormat ============
class RelativeTimeFormat implements Intl.RelativeTimeFormat {
    private locale: string;
    private options: Intl.RelativeTimeFormatOptions;
    private data: typeof localeData.zh | typeof localeData.en;

    constructor(locale?: string | string[], options?: Intl.RelativeTimeFormatOptions) {
        this.locale = normalizeLocale(locale);
        this.options = { numeric: 'always', style: 'long', ...options };
        
        const lang = this.locale.startsWith('zh') ? 'zh' : 'en';
        this.data = localeData[lang];
    }

    format(value: number, unit: Intl.RelativeTimeFormatUnit): string {
        const normalizedUnit = normalizeRelativeTimeUnit(unit);
        const rtData = this.data.relativeTime;
        
        // Auto mode for special cases
        if (this.options.numeric === 'auto' && Math.abs(value) <= 1) {
            const autoValues = rtData.auto[normalizedUnit];
            const autoKey = value === -1 ? '-1' : value === 0 ? '0' : value === 1 ? '1' : undefined;
            const autoText = autoKey ? autoValues?.[autoKey] : undefined;
            if (autoText) return autoText;
        }
        
        const absValue = Math.abs(value);
        const unitData = rtData.units[normalizedUnit];
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
    
    get [Symbol.toStringTag]() {
        return 'Intl.RelativeTimeFormat';
    }
}

// ============ DisplayNames ============
class DisplayNames implements Intl.DisplayNames {
    private locale: string;
    private type: Intl.DisplayNamesType;
    private data: typeof localeData.zh | typeof localeData.en;

    constructor(locale?: string | string[], options?: Intl.DisplayNamesOptions) {
        this.locale = normalizeLocale(locale);
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
    
    get [Symbol.toStringTag]() {
        return 'Intl.DisplayNames';
    }
}

// ============ Collator ============
class Collator implements Intl.Collator {
    private locale: string;
    private options: Intl.CollatorOptions;

    constructor(locales?: Intl.LocalesArgument, options?: Intl.CollatorOptions) {
        this.locale = normalizeLocale(locales);
        this.options = {
            usage: 'sort',
            sensitivity: 'variant',
            ignorePunctuation: false,
            numeric: false,
            caseFirst: 'false',
            ...options,
        };
    }

    static supportedLocalesOf(locales: string | string[]): string[] {
        return supportedLocalesOf(locales);
    }
    
    /**
     * Three-level root collation: primary = base letters (case- and accent-folded),
     * secondary = accents, tertiary = case. This is DUCET-shaped, NOT locale-tailored:
     * correct for en/de/fr/es, WRONG for sv/da where a-umlaut sorts after z.
     */
    private compareKeys(a: string, b: string): number {
        const sensitivity = this.options.sensitivity ?? 'variant';
        const primary = codepointCompare(primaryKey(a), primaryKey(b));
        if (primary !== 0) return primary;
        if (sensitivity === 'base') return 0;
        if (sensitivity !== 'case') {
            const secondary = codepointCompare(secondaryKey(a), secondaryKey(b));
            if (secondary !== 0) return secondary;
        }
        if (sensitivity === 'accent') return 0;
        const tertiary = caseCompare(a, b);
        return this.options.caseFirst === 'upper' ? -tertiary : tertiary;
    }

    compare: (x: string, y: string) => number = (a, b) => {
        let left = String(a);
        let right = String(b);
        if (this.options.ignorePunctuation) {
            left = stripPunctuation(left);
            right = stripPunctuation(right);
        }
        const base = (x: string, y: string) => this.compareKeys(x, y);
        return this.options.numeric ? numericCompare(left, right, base) : base(left, right);
    };
    
    resolvedOptions(): Intl.ResolvedCollatorOptions {
        return {
            locale: this.locale,
            usage: this.options.usage || 'sort',
            sensitivity: this.options.sensitivity || 'variant',
            ignorePunctuation: this.options.ignorePunctuation === true,
            collation: 'default',
            numeric: this.options.numeric === true,
            caseFirst: this.options.caseFirst || 'false',
        };
    }
    
    get [Symbol.toStringTag]() {
        return 'Intl.Collator';
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
    
    get [Symbol.toStringTag]() {
        return 'Intl.PluralRules';
    }
}

// ============ Locale ============
class Locale implements Intl.Locale {
    baseName: string;
    language: string;
    region: string | undefined;
    script: string | undefined;
    caseFirst: 'upper' | 'lower' | 'false' | undefined;
    collation: string | undefined;
    calendar: string | undefined;
    hourCycle: 'h11' | 'h12' | 'h23' | 'h24' | undefined;
    numberingSystem: string | undefined;
    variants: string | undefined;

    constructor(tag: string) {
        this.baseName = tag;
        this.language = tag.split('-')[0];
        const parts = tag.split('-');
        this.region = parts.length > 1 && parts[1].length === 2 ? parts[1] : '';
        this.script = '';
        this.caseFirst = 'false';
        this.collation = undefined;
        this.calendar = undefined;
        this.hourCycle = undefined;
        this.numberingSystem = undefined;
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

    getCalendars(): string[] {
        return ['gregory'];
    }

    getCollations(): string[] {
        return ['default'];
    }

    getHourCycles(): string[] {
        return ['h12'];
    }

    getNumberingSystems(): string[] {
        return ['latn'];
    }

    getTextInfo(): { direction: 'ltr' | 'rtl' } {
        return { direction: 'ltr' };
    }

    getTimeZones(): string[] | undefined {
        return undefined;
    }

    getWeekInfo(): { firstDay: number; weekend: number[]; minimalDays: number } {
        return { firstDay: 1, weekend: [6, 7], minimalDays: 1 };
    }
    
    get [Symbol.toStringTag]() {
        return 'Intl.Locale';
    }
}

// ============ ListFormat ============
class ListFormat implements Intl.ListFormat {
    private locale: string;
    private type: Intl.ListFormatType;
    private style: Intl.ListFormatStyle;
    
    constructor(locale?: string | string[], options?: Intl.ListFormatOptions) {
        this.locale = normalizeLocale(locale);
        this.type = options?.type ?? 'conjunction';
        this.style = options?.style ?? 'long';
    }

    private middleSeparator(): string {
        if (this.locale.startsWith('zh')) return '、';
        if (this.type === 'unit') return this.style === 'narrow' ? ' ' : ', ';
        return ', ';
    }

    private finalSeparator(length: number): string {
        if (this.locale.startsWith('zh')) return this.type === 'disjunction' ? '或' : '和';
        if (this.type === 'disjunction') return length > 2 ? ', or ' : ' or ';
        if (this.type === 'unit') return this.style === 'narrow' ? ' ' : ', ';
        return length > 2 ? ', and ' : ' and ';
    }
    
    format(list: Iterable<string>): string {
        return this.formatToParts(list).map(part => part.value).join('');
    }
    
    formatToParts(list: Iterable<string>): { type: "element" | "literal"; value: string; }[] {
        const arr = Array.from(list, value => String(value));
        const parts: { type: "element" | "literal"; value: string; }[] = [];
        for (let i = 0; i < arr.length; i++) {
            if (i > 0) {
                parts.push({
                    type: 'literal',
                    value: i === arr.length - 1 ? this.finalSeparator(arr.length) : this.middleSeparator(),
                });
            }
            const value = arr[i];
            if (value !== undefined) parts.push({ type: 'element', value });
        }
        return parts;
    }
    
    resolvedOptions(): Intl.ResolvedListFormatOptions {
        return {
            locale: this.locale,
            type: this.type,
            style: this.style
        };
    }
    
    get [Symbol.toStringTag]() {
        return 'Intl.ListFormat';
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
    
    get [Symbol.toStringTag]() {
        return 'Intl.Segmenter';
    }
}

// ============ Plain-call support ============
// ECMA-402 allows DateTimeFormat, NumberFormat and Collator to be called without
// `new`; the other seven constructors must throw TypeError. An ES2015 `class` binding
// always throws on [[Call]], which is why `Intl.NumberFormat('en')` failed here. Wrap
// the three permitted ones in an ordinary function that constructs either way and
// shares the class prototype, so `instanceof` and the statics keep working.
function asCallable<T>(Cls: T, name: string): T {
    const Ctor = Cls as unknown as new (...args: unknown[]) => object;
    const wrapper = function (...args: unknown[]) {
        return new Ctor(...args);
    };
    Object.defineProperty(wrapper, 'name', { value: name, configurable: true });
    Object.defineProperty(wrapper, 'prototype', { value: Ctor.prototype });
    for (const key of Object.getOwnPropertyNames(Ctor)) {
        if (key === 'prototype' || key === 'name' || key === 'length') continue;
        const descriptor = Object.getOwnPropertyDescriptor(Ctor, key);
        if (descriptor) Object.defineProperty(wrapper, key, descriptor);
    }
    return wrapper as unknown as T;
}

/** Time zones this implementation can honour exactly. Node lists 418 IANA names; cno
 * ships no tzdata, so reporting only what actually works keeps feature detection
 * meaningful. Offset literals are accepted too but are not enumerable. */
function honouredTimeZones(): string[] {
    const out = ['UTC'];
    for (let n = 14; n >= 1; n--) out.push('Etc/GMT-' + n);
    out.push('Etc/GMT');
    for (let n = 1; n <= 12; n++) out.push('Etc/GMT+' + n);
    return out;
}

// ============ Main Intl Object ============
export class CustomIntl {
    // Callable without `new`, per ECMA-402.
    NumberFormat = asCallable(NumberFormat, 'NumberFormat');
    DateTimeFormat = asCallable(DateTimeFormat, 'DateTimeFormat');
    Collator = asCallable(Collator, 'Collator');
    // Must throw without `new`; left as class bindings deliberately.
    RelativeTimeFormat = RelativeTimeFormat;
    DisplayNames = DisplayNames;
    PluralRules = PluralRules;
    Locale = Locale;
    ListFormat = ListFormat;
    Segmenter = Segmenter;

    getCanonicalLocales(locales: string | string[]): string[] {
        const input = Array.isArray(locales) ? locales : [locales];
        const out: string[] = [];
        const seen = new Set<string>();
        for (const locale of input) {
            const normalized = canonicalizeLocale(locale);
            if (!normalized || seen.has(normalized)) continue;
            seen.add(normalized);
            out.push(normalized);
        }
        return out;
    }
    
    /**
     * Only the values cno can actually honour, and RangeError for an unknown key
     * (node's message shape). Previously this returned the locale list for every key.
     */
    supportedValuesOf(key: string): string[] {
        if (key === 'calendar') return ['gregory'];
        // ECMA-402 excludes 'default' from the collation list, and cno has nothing else.
        if (key === 'collation') return [];
        if (key === 'currency') return ['CNY', 'EUR', 'GBP', 'HKD', 'JPY', 'KRW', 'TWD', 'USD'];
        if (key === 'numberingSystem') return ['latn'];
        if (key === 'timeZone') return honouredTimeZones();
        if (key === 'unit') return [];
        throw new RangeError('Invalid key : ' + key);
    }
    
    get [Symbol.toStringTag]() {
        return 'Intl';
    }
}

Reflect.set(globalThis, 'Intl', new CustomIntl());

// ============ Date/Number prototype re-points ============
// quickjs implements Date.prototype.toLocale*String in C (quickjs.c get_date_string,
// magic 0x31/0x32/0x33) and Number.prototype.toLocaleString via js_number_toString.
// None of them consult Intl, so `date.toLocaleString('en-US', {timeZone: 'UTC'})`
// silently ignored BOTH arguments and formatted in the host zone. Fixing
// Intl.DateTimeFormat alone therefore does not fix the most common call site.
// OBSERVED in the shipped binary: all four descriptors are writable+configurable,
// so re-pointing them from this layer works without touching the off-limits C.

const DATE_REQUEST_KEYS = ['weekday', 'year', 'month', 'day', 'dateStyle'] as const;
const TIME_REQUEST_KEYS = [
    'dayPeriod', 'hour', 'minute', 'second', 'fractionalSecondDigits', 'timeStyle',
] as const;

function hasAnyKey(options: Record<string, unknown>, keys: readonly string[]): boolean {
    for (const key of keys) if (options[key] !== undefined) return true;
    return false;
}

/**
 * ECMA-402 ToDateTimeOptions. Defaults are only filled in when the caller asked for
 * nothing in that group: toLocaleString('en-US', {year:'numeric'}) is just "2021",
 * while toLocaleDateString('en-US', {hour:'numeric'}) is "3/4/2021, 3 PM" (OBSERVED).
 */
function toDateTimeOptions(
    options: Intl.DateTimeFormatOptions | undefined,
    mode: 'all' | 'date' | 'time',
): Intl.DateTimeFormatOptions {
    const out: Record<string, unknown> = { ...(options ?? {}) };
    // A style from the other group is a TypeError, not a silent extra field: node
    // rejects toLocaleTimeString(.., {dateStyle}) and toLocaleDateString(.., {timeStyle}).
    if (mode === 'time' && out.dateStyle !== undefined) {
        throw new TypeError('dateStyle is not supported by toLocaleTimeString');
    }
    if (mode === 'date' && out.timeStyle !== undefined) {
        throw new TypeError('timeStyle is not supported by toLocaleDateString');
    }
    const wantDate = mode === 'all' || mode === 'date';
    const wantTime = mode === 'all' || mode === 'time';
    const hasDate = hasAnyKey(out, DATE_REQUEST_KEYS);
    const hasTime = hasAnyKey(out, TIME_REQUEST_KEYS);
    const fillDate = mode === 'all' ? !hasDate && !hasTime : wantDate && !hasDate;
    const fillTime = mode === 'all' ? !hasDate && !hasTime : wantTime && !hasTime;
    if (fillDate) {
        out.year = 'numeric';
        out.month = 'numeric';
        out.day = 'numeric';
    }
    if (fillTime) {
        out.hour = 'numeric';
        out.minute = 'numeric';
        out.second = 'numeric';
    }
    return out as Intl.DateTimeFormatOptions;
}

function dateToLocaleParts(
    self: Date,
    locales: Intl.LocalesArgument | undefined,
    options: Intl.DateTimeFormatOptions | undefined,
    mode: 'all' | 'date' | 'time',
): string {
    const time = self.getTime();
    // Unlike Intl.DateTimeFormat#format, which throws, toLocale*String reports the
    // string 'Invalid Date' for a NaN time value (OBSERVED node).
    if (!Number.isFinite(time)) return 'Invalid Date';
    const locale = (Array.isArray(locales) ? locales[0] : locales) as string | undefined;
    return new DateTimeFormat(locale, toDateTimeOptions(options, mode)).format(time);
}

function definePrototypeMethod(target: object, name: string, value: (...args: never[]) => unknown) {
    Object.defineProperty(target, name, {
        value,
        writable: true,
        enumerable: false,
        configurable: true,
    });
}

definePrototypeMethod(Date.prototype, 'toLocaleString', function (
    this: Date,
    locales?: Intl.LocalesArgument,
    options?: Intl.DateTimeFormatOptions,
): string {
    return dateToLocaleParts(this, locales, options, 'all');
} as (...args: never[]) => unknown);

definePrototypeMethod(Date.prototype, 'toLocaleDateString', function (
    this: Date,
    locales?: Intl.LocalesArgument,
    options?: Intl.DateTimeFormatOptions,
): string {
    return dateToLocaleParts(this, locales, options, 'date');
} as (...args: never[]) => unknown);

definePrototypeMethod(Date.prototype, 'toLocaleTimeString', function (
    this: Date,
    locales?: Intl.LocalesArgument,
    options?: Intl.DateTimeFormatOptions,
): string {
    return dateToLocaleParts(this, locales, options, 'time');
} as (...args: never[]) => unknown);

definePrototypeMethod(Number.prototype, 'toLocaleString', function (
    this: number,
    locales?: Intl.LocalesArgument,
    options?: Intl.NumberFormatOptions,
): string {
    const locale = (Array.isArray(locales) ? locales[0] : locales) as string | undefined;
    return new NumberFormat(locale, options).format(Number(this));
} as (...args: never[]) => unknown);

definePrototypeMethod(BigInt.prototype, 'toLocaleString', function (
    this: bigint,
    locales?: Intl.LocalesArgument,
    options?: Intl.NumberFormatOptions,
): string {
    const locale = (Array.isArray(locales) ? locales[0] : locales) as string | undefined;
    // A boxed BigInt object reaches here as `this`; valueOf() normalises both cases.
    const value = BigInt.prototype.valueOf.call(this);
    return new NumberFormat(locale, options).format(value);
} as (...args: never[]) => unknown);

// Deliberately NOT re-pointed: String.prototype.localeCompare. It has three live
// callers in this tree (cts/src/utils/misc.ts:291, src/commands/repl/completion.ts:83,
// tests/deno/fs-upstream-compat.test.ts) and root collation reorders results relative
// to the current codepoint compare, which would move a currently-green test for no
// gain against the stated priorities.

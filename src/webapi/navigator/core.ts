const os = import.meta.use('os');
const engine = import.meta.use('engine');

const uname = os.uname();
function getPlatform(): string {
    const platform = uname.sysname;
    const machine = uname.machine;

    switch (platform) {
        case 'Linux':
            return machine === 'x86_64' ? 'Linux x86_64' : `Linux ${machine}`;
        case 'Darwin':
            return machine === 'arm64' ? 'MacIntel' : 'MacIntel';
        case 'Windows_NT':
            return 'win32';
        default:
            if (machine.includes('MSYS') || machine.includes('MINGW')) {
                return 'win32';
            }
            return `${platform} ${machine}`;
    }
}

function getUserAgent(): string {
    const platform = uname.sysname;
    const machine = uname.machine;
    const version = engine.versions.core;

    const archMap: Record<string, string> = {
        x86_64: 'x86_64',
        amd64: 'x86_64',
        aarch64: 'arm64',
        arm64: 'arm64',
        i386: 'i686',
        i686: 'i686',
    };

    const arch = archMap[machine] || machine;

    switch (platform) {
        case 'Linux':
            return `Mozilla/5.0 (X11; Linux ${arch}) AppleWebKit/537.36 (KHTML, like Gecko) denort/${version} Safari/537.36`;
        case 'Darwin':
            return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) denort/${version} Safari/537.36`;
        case 'Windows_NT':
            return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) denort/${version} Safari/537.36`;
        default:
            return `Mozilla/5.0 (${platform}; ${arch}) AppleWebKit/537.36 (KHTML, like Gecko) denort/${version} Safari/537.36`;
    }
}

function getLanguage(): string {
    const lang = os.getenv('LANG') || os.getenv('LC_ALL') || os.getenv('LC_MESSAGES');
    if (lang) {
        const match = lang.match(/^([a-z]{2}_[A-Z]{2})/);
        if (match) {
            return match[1].replace('_', '-');
        }
        const match2 = lang.match(/^([a-z]{2})/);
        if (match2) {
            return match2[1];
        }
    }
    return 'en-US';
}

function getLanguages(): string[] {
    const lang = getLanguage();
    const baseLang = lang.split('-')[0];
    return [lang, baseLang];
}

function getDeviceMemory(): number {
    const memory = os.memoryUsage();
    const totalGB = memory['os.total'] / (1024 * 1024 * 1024);
    const memorySteps = [0.25, 0.5, 1, 2, 4, 8, 16, 32, 64, 128, 256, 512];
    for (const step of memorySteps) {
        if (totalGB <= step) {
            return step;
        }
    }
    return 512;
}

export class NavigatorCoreImpl{
    get platform(): string {
        return getPlatform();
    }

    get userAgent(): string {
        return getUserAgent();
    }

    get vendor(): string {
        return 'denort';
    }

    get appName(): string {
        return 'Netscape';
    }

    get appVersion(): string {
        return this.userAgent.substring(8);
    }

    get language(): string {
        return getLanguage();
    }

    get languages(): string[] {
        return getLanguages();
    }

    get hardwareConcurrency(): number {
        return os.availableParallelism();
    }

    get deviceMemory(): number {
        return getDeviceMemory();
    }

    get cookieEnabled(): boolean {
        return false;
    }

    get product(): string {
        return 'Gecko';
    }

    get productSub(): string {
        return '20030107';
    }

    get vendorSub(): string {
        return '';
    }

    javaEnabled(): boolean {
        return false;
    }
}

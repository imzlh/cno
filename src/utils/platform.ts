const os = import.meta.use('os');

function getEnv(name: string): string | null {
    try {
        return os.getenv(name) ?? null;
    } catch {
        return null;
    }
}

const platform = os.uname().sysname;
export const isWindows = platform === 'Windows_NT' || platform.startsWith('MSYS');
export const isPosixCompatible = platform != 'Windows_NT'; // MSYS is unix-compatible
export const isMac = platform === 'Darwin';
export const osShell = (() => {
    if (isPosixCompatible) {
        return getEnv('SHELL') || '/bin/sh';
    }
    return getEnv('COMSPEC') || 'cmd.exe';
})();
export const osDynLibExtension = isPosixCompatible ? (isMac ? '.dylib' : '.so') : '.dll';

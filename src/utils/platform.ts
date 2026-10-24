const os = import.meta.use('os');

function getEnv(name: string): string | null {
    try {
        return os.getenv(name) ?? null;
    } catch {
        return null;
    }
}

/** `os.platform` is CMAKE_SYSTEM_NAME lowercased; Node spells Windows 'win32'. */
export const platform = os.platform;
export const isWindows = platform === 'windows' || platform === 'win32';
export const isMac = platform === 'darwin' || platform === 'macos';
export const isLinux = platform === 'linux';
export const isPosixCompatible = !isWindows; // MSYS is unix-compatible
export const osShell = (() => {
    if (isPosixCompatible) {
        return getEnv('SHELL') || '/bin/sh';
    }
    return getEnv('COMSPEC') || 'cmd.exe';
})();
export const osDynLibExtension = isPosixCompatible ? (isMac ? '.dylib' : '.so') : '.dll';

const os = import.meta.use('os');

function getEnv(name: string) {
    try{ return os.getenv(name); } catch { return null; }
}

const platform = os.uname().sysname;
export const isWindows = platform === 'Windows_NT' || platform.startsWith('MSYS');
export const isUnixCompatible = platform != 'Windows_NT'; // MSYS is unix-compatible
export const isMac = platform === 'Darwin';
export const osShell = (() => {
    if (isUnixCompatible) { 
        return getEnv('SHELL') || '/bin/sh';
    } else {
        return getEnv('COMSPEC') || 'cmd.exe';
    }
})();
export const osDynLibExtension = isUnixCompatible ? (isMac ? '.dylib' : '.so') : '.dll';
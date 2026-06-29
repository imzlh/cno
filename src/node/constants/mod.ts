import { constants as fsConstants } from '../fs/constants';
import { constants as osConstants } from '../os/mod';
import { constants as cryptoConstants } from '../crypto/mod';
import { constants as zlibConstants } from '../zlib/mod';

const nested = {
    os: osConstants,
    fs: fsConstants,
    crypto: cryptoConstants,
    zlib: zlibConstants,
};

export const constants = Object.freeze({
    ...fsConstants,
    ...cryptoConstants,
    ...zlibConstants,
    ...osConstants.errno,
    ...osConstants.signals,
    ...osConstants.priority,
    ...osConstants.dlopen,
    ...nested,
});

export const {
    os,
    fs,
    crypto,
    zlib,
    signals,
    errno,
    dlopen,
    priority,
} = constants as typeof constants & {
    os: typeof osConstants;
    fs: typeof fsConstants;
    crypto: typeof cryptoConstants;
    zlib: typeof zlibConstants;
};

export default constants;

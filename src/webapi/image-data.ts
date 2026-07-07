type ImageDataArray = globalThis.ImageData['data'];
type ImageDataPixelFormat = globalThis.ImageData['pixelFormat'];
type PredefinedColorSpace = globalThis.ImageData['colorSpace'];

const validateDimension = (value: number, name: string): number => {
    const number = Number(value);
    if (!Number.isInteger(number) || number <= 0) {
        throw new RangeError(`${name} must be a positive integer`);
    }
    return number;
};

const normalizeColorSpace = (value: unknown): PredefinedColorSpace => {
    if (value === undefined) return 'srgb';
    if (value === 'srgb' || value === 'display-p3') return value;
    throw new TypeError('Unsupported ImageData colorSpace');
};

const normalizePixelFormat = (
    value: unknown,
    data?: ImageDataArray
): ImageDataPixelFormat => {
    if (value === undefined) {
        return data instanceof Float16Array ? 'rgba-float16' : 'rgba-unorm8';
    }
    if (value === 'rgba-unorm8' || value === 'rgba-float16') return value;
    throw new TypeError('Unsupported ImageData pixelFormat');
};

const isImageDataArray = (value: unknown): value is ImageDataArray =>
    value instanceof Uint8ClampedArray || value instanceof Float16Array;

class ImageData implements globalThis.ImageData {
    readonly data: ImageDataArray;
    readonly width: number;
    readonly height: number;
    readonly colorSpace: PredefinedColorSpace;
    readonly pixelFormat: ImageDataPixelFormat;

    constructor(sw: number, sh: number, settings?: ImageDataSettings);
    constructor(data: ImageDataArray, sw: number, sh?: number, settings?: ImageDataSettings);
    constructor(
        dataOrWidth: number | ImageDataArray,
        widthOrHeight: number,
        heightOrSettings?: number | ImageDataSettings,
        settings?: ImageDataSettings
    ) {
        if (isImageDataArray(dataOrWidth)) {
            const options = settings ?? (typeof heightOrSettings === 'object' ? heightOrSettings : undefined);
            const width = validateDimension(widthOrHeight, 'width');
            const height = typeof heightOrSettings === 'number'
                ? validateDimension(heightOrSettings, 'height')
                : dataOrWidth.length / (width * 4);
            if (!Number.isInteger(height) || height <= 0) {
                throw new RangeError('ImageData data length does not match width');
            }

            const pixelFormat = normalizePixelFormat(options?.pixelFormat, dataOrWidth);
            if (pixelFormat === 'rgba-unorm8' && !(dataOrWidth instanceof Uint8ClampedArray)) {
                throw new TypeError('rgba-unorm8 ImageData requires Uint8ClampedArray data');
            }
            if (pixelFormat === 'rgba-float16' && !(dataOrWidth instanceof Float16Array)) {
                throw new TypeError('rgba-float16 ImageData requires Float16Array data');
            }
            if (dataOrWidth.length !== width * height * 4) {
                throw new RangeError('ImageData data length does not match dimensions');
            }

            this.data = dataOrWidth;
            this.width = width;
            this.height = height;
            this.pixelFormat = pixelFormat;
            this.colorSpace = normalizeColorSpace(options?.colorSpace);
            return;
        }

        const options = typeof heightOrSettings === 'object' ? heightOrSettings : settings;
        const width = validateDimension(dataOrWidth, 'width');
        const height = validateDimension(widthOrHeight, 'height');
        const pixelFormat = normalizePixelFormat(options?.pixelFormat);
        const length = width * height * 4;

        this.data = pixelFormat === 'rgba-float16'
            ? new Float16Array(length) as ImageDataArray
            : new Uint8ClampedArray(length) as ImageDataArray;
        this.width = width;
        this.height = height;
        this.pixelFormat = pixelFormat;
        this.colorSpace = normalizeColorSpace(options?.colorSpace);
    }

    get [Symbol.toStringTag]() {
        return 'ImageData';
    }
}

Reflect.set(globalThis, 'ImageData', ImageData);

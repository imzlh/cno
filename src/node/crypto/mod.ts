/**
 * Node.js crypto module — public surface.
 *
 * This file is a facade: the implementation lives in the sibling modules listed
 * below, and the export list here IS the public API. It is deliberately spelled
 * out name by name rather than using `export *`, because the submodules also
 * export internals to each other (error factories, mode tables, key encoders)
 * and `export *` would silently publish those as `node:crypto` exports.
 *
 *   errors.ts        error factories + argument validation
 *   curves.ts        EC curve name resolution
 *   helpers.ts       byte/encoding helpers, key format probes, DER<->P1363
 *   keys.ts          KeyObject, createPrivateKey/createPublicKey/createSecretKey
 *   keygen.ts        generateKeyPair(Sync), RFC 8410 PKCS#8 builder
 *   sigcodec.ts      ECDSA signature re-encoding (dsaEncoding)
 *   digest.ts        Hash / Hmac
 *   cipher-modes.ts  ECB/CBC native tables + incremental cores
 *   cipher.ts        createCipheriv / createDecipheriv, GCM, one-shot AES
 *   sign.ts          createSign / createVerify, one-shot sign / verify
 *   ec.ts            ECDSA, ECDH, diffieHellman
 *   rsa.ts           RSA-OAEP, RSA-PSS
 *   random.ts        randomBytes, randomFill, pbkdf2, scrypt, hkdf, timingSafeEqual
 *   misc.ts          encodings, padding constants, algorithm enumeration
 *   webcrypto.ts     webcrypto / subtle
 */

export type { BinaryInput, KeyInput, KeyWithOptions, KeyExportOptions, SecretJwk, AsymmetricKeyType, Hash, Hmac, Cipheriv, Decipheriv, CipherGCM, DecipherGCM, GcmEncryptResult, GcmDecryptResult, CipherInfo, Sign, Verify } from './types';
export type { ScryptOptions } from './random';

export { KeyObject, createPrivateKey, createPublicKey, createSecretKey } from './keys';

export { generateKeyPair, generateKeyPairSync } from './keygen';

export {
    createHash, hash, createHmac, hmac,
    md5, sha1, sha224, sha256, sha384, sha512,
    sha3_224, sha3_256, sha3_384, sha3_512,
    createMd5, createSha1, createSha256, createSha512, createSha512_224, createSha512_256,
    createBlake2b512, createBlake2s256,
    hmacMd5, hmacSha1, hmacSha256, hmacSha512, hmacSha512_224, hmacSha512_256,
    hmacSha3_224, hmacSha3_256, hmacSha3_384, hmacSha3_512,
    hmacBlake2b512, hmacBlake2s256, createHmacSha256, createHmacSha512,
} from './digest';

export {
    createCipheriv, createDecipheriv, createCipherivGCM, createDecipherivGCM,
    createCipherAes256Cbc, createDecipherAes256Cbc,
    gcmEncrypt, gcmDecrypt, cipheriv, decipheriv,
    aes128CbcEncrypt, aes128CbcDecrypt, aes256CbcEncrypt, aes256CbcDecrypt,
    aes128GcmEncrypt, aes128GcmDecrypt, aes256GcmEncrypt, aes256GcmDecrypt,
} from './cipher';

export {
    createSign, createVerify, sign, verify, generateRsaKey,
    signSha224, signSha256, signSha384, signSha512,
    verifySha224, verifySha256, verifySha384, verifySha512,
} from './sign';

export {
    ECDH, createECDH, getCurves, diffieHellman, ecdhComputeSecret,
    ecdsaSign, ecdsaVerify,
    generateEcKeyP256, generateEcKeyP384, generateEcKeyP521,
    ecdsaSignP256, ecdsaSignP384, ecdsaSignP521,
    ecdsaVerifyP256, ecdsaVerifyP384, ecdsaVerifyP521,
    ecdhDeriveP256, ecdhDeriveP384, ecdhDeriveP521,
} from './ec';

export {
    publicEncrypt, privateDecrypt,
    rsaOaepSha256Encrypt, rsaOaepSha256Decrypt, rsaOaepSha512Encrypt, rsaOaepSha512Decrypt,
    rsaPssSha256Sign, rsaPssSha256Verify,
} from './rsa';

export {
    randomBytes, pseudoRandomBytes, getRandomValues, timingSafeEqual,
    randomInt, randomFill, randomFillSync,
    pbkdf2, pbkdf2Sync, pbkdf2Sha1, pbkdf2Sha256, pbkdf2Sha512,
    scrypt, scryptSync, hkdf, hkdfSync, hkdfSha256, hkdfSha512,
} from './random';

export {
    constants, getHashes, getCiphers, getCipherInfo, randomUUID,
    crc32, base64Encode, base64Decode, hexEncode, hexDecode,
} from './misc';

export { webcrypto, subtle } from './webcrypto';

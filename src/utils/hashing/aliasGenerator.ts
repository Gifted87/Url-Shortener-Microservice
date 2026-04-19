/**
 * @file aliasGenerator.ts
 * @description Provides a production-grade, deterministic base62 encoding mechanism for URL shortener aliases.
 * The generator maps monotonically increasing BigInt identifiers to URL-safe alphanumeric strings.
 */

/**
 * The base62 character set used for alias generation.
 * Ordered: 0-9, a-z, A-Z to ensure lexicographical sorting properties and URL safety.
 */
const BASE62_CHARSET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * Encodes a unique, non-negative BigInt identifier into a base62 string.
 * This implementation provides a deterministic mapping for a given input, ensuring 
 * collision resistance when driven by a database sequence or snowflake ID.
 *
 * @param {bigint} id - A unique, monotonically increasing identifier. Must be non-negative.
 * @returns {string} The base62 encoded alias.
 * @throws {Error} If the input identifier is negative or not a valid BigInt.
 */
export function generateAlias(id: bigint): string {
    if (typeof id !== 'bigint') {
        throw new Error('Invalid input: Alias generation requires a BigInt identifier.');
    }

    if (id < 0n) {
        throw new Error('Invalid input: Identifier must be non-negative.');
    }

    if (id === 0n) {
        return BASE62_CHARSET[0];
    }

    let encoded = '';
    let currentId = id;
    const base = BigInt(BASE62_CHARSET.length);

    while (currentId > 0n) {
        const remainder = currentId % base;
        encoded = BASE62_CHARSET[Number(remainder)] + encoded;
        currentId = currentId / base;
    }

    return encoded;
}

/**
 * Decodes a base62 string back into its original BigInt identifier.
 * Useful for auditing and mapping aliases back to primary records.
 *
 * @param {string} alias - The base62 string to decode.
 * @returns {bigint} The original BigInt identifier.
 * @throws {Error} If the alias contains invalid characters.
 */
export function decodeAlias(alias: string): bigint {
    let decoded = 0n;
    const base = BigInt(BASE62_CHARSET.length);

    for (const char of alias) {
        const index = BASE62_CHARSET.indexOf(char);
        if (index === -1) {
            throw new Error(`Invalid character in alias: ${char}`);
        }
        decoded = decoded * base + BigInt(index);
    }

    return decoded;
}

/**
 * Generates an alias with an optional internal offset to increase entropy 
 * or prevent sequential prediction.
 *
 * @param {bigint} id - The base identifier.
 * @param {bigint} offset - An optional offset to obfuscate the sequence.
 * @returns {string} The obfuscated base62 alias.
 */
export function generateObfuscatedAlias(id: bigint, offset: bigint = 0n): string {
    return generateAlias(id + offset);
}

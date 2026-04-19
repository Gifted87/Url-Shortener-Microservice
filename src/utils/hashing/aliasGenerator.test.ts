import { generateAlias, decodeAlias, generateObfuscatedAlias } from './aliasGenerator';

describe('Alias Generator', () => {
    describe('generateAlias', () => {
        it('should correctly encode 0n to the first character', () => {
            expect(generateAlias(0n)).toBe('0');
        });

        it('should correctly encode a positive BigInt to a base62 string', () => {
            expect(generateAlias(123456789n)).toBe('8m0Kx');
            expect(generateAlias(61n)).toBe('Z');
            expect(generateAlias(62n)).toBe('10');
        });

        it('should throw an error for negative BigInts', () => {
            expect(() => generateAlias(-1n)).toThrow('Invalid input: Identifier must be non-negative.');
        });

        it('should throw an error if input is not a BigInt', () => {
            expect(() => generateAlias(123 as any)).toThrow('Invalid input: Alias generation requires a BigInt identifier.');
        });
    });

    describe('decodeAlias', () => {
        it('should correctly decode base62 string back to BigInt', () => {
            expect(decodeAlias('0')).toBe(0n);
            expect(decodeAlias('8m0Kx')).toBe(123456789n);
            expect(decodeAlias('Z')).toBe(61n);
            expect(decodeAlias('10')).toBe(62n);
        });

        it('should throw an error for invalid characters in alias', () => {
            expect(() => decodeAlias('invalid-char!')).toThrow('Invalid character in alias: -');
        });
    });

    describe('generateObfuscatedAlias', () => {
        it('should generate obfuscated alias by applying an offset', () => {
            const id = 123n;
            const offset = 1000n;
            expect(generateObfuscatedAlias(id, offset)).toBe(generateAlias(id + offset));
        });

        it('should generate normal alias if offset is 0n', () => {
            expect(generateObfuscatedAlias(123n, 0n)).toBe(generateAlias(123n));
            expect(generateObfuscatedAlias(123n)).toBe(generateAlias(123n));
        });
    });
});

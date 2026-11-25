/** Single-quote a string for POSIX sh. A leaf module (no imports), so any module can use it without an import cycle. */
export const shq = (s: string | number) => `'${String(s).replace(/'/g, `'\\''`)}'`;

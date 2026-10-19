// web-encoding ships src/lib.d.ts, but its exports map names only the
// JavaScript entries, so bundler module resolution finds no declarations.
// The package re-exports the platform's TextEncoder and TextDecoder.
declare module 'web-encoding' {
  export const TextEncoder: typeof globalThis.TextEncoder;
  export const TextDecoder: typeof globalThis.TextDecoder;
}

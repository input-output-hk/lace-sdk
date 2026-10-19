// get-random-values ships no declarations. It fills a typed array with
// cryptographically random values, in Node and in browsers.
declare module 'get-random-values' {
  function getRandomValues<T extends ArrayBufferView>(array: T): T;
  export = getRandomValues;
}

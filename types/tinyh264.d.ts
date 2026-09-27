// tinyh264 ships no types. Its worker-side entry registers the message
// handler and resolves once the WebAssembly module is ready.
declare module "tinyh264" {
  export function init(): Promise<void>;
}

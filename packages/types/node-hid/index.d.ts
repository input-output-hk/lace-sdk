// node-hid 2.2.0 ships no declarations (3.x does). This is the surface
// @lace-lib/cardano-hardware-ledger uses: the HID device class, as a value
// for instanceof checks and as the type of a device the Ledger transport
// opened.
declare module 'node-hid' {
  interface Device {
    vendorId: number;
    productId: number;
    path?: string;
    serialNumber?: string;
    manufacturer?: string;
    product?: string;
    release: number;
    interface: number;
    usagePage?: number;
    usage?: number;
  }
  class HID {
    constructor(path: string);
    constructor(vendorId: number, productId: number);
    close(): void;
    pause(): void;
    resume(): void;
    read(callback: (error: unknown, data: Buffer) => void): void;
    readSync(): number[];
    readTimeout(timeout: number): number[];
    write(values: Buffer | number[]): number;
    getFeatureReport(reportId: number, reportLength: number): number[];
    sendFeatureReport(data: Buffer | number[]): number;
    setNonBlocking(nonBlocking: boolean | 0 | 1): void;
    getDeviceInfo(): Device;
  }
  function devices(vendorId?: number, productId?: number): Device[];
  function setDriverType(type: 'hidraw' | 'libusb'): void;
}

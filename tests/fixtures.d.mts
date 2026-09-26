export function writeEpub(filePath: string, options?: { fixed?: boolean; encrypted?: boolean; malicious?: boolean; remoteUrl?: string }): Promise<string>;
export function writePdf(filePath: string, options?: { title?: string; pages?: number; scanned?: boolean }): Promise<string>;
export function writeMixedFixtures(dir: string): Promise<{ txt: string; epub: string; pdf: string }>;

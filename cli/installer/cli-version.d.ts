export declare function isVersionRequest(argv?: string[]): boolean;

export declare function readVersion(options?: {
  readFileSync?: (path: string, encoding: string) => string;
  root?: string;
}): string;

/** Returns 0 when the version was printed, or null when argv is not a version request. */
export declare function printVersion(options?: {
  argv?: string[];
  write?: (line: string) => void;
  readFileSync?: (path: string, encoding: string) => string;
  root?: string;
}): number | null;

export declare const VERSION_FLAGS: Set<string>;

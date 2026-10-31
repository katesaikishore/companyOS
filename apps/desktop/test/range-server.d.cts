export interface RangeRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
}

export interface RangeInfo {
  name: string;
  via: 'resolve' | 'cdn';
  start: number;
  ranged: boolean;
  count: number;
}

export interface RangeAction {
  truncateAt?: number;
  stallAt?: number;
  corrupt?: boolean;
  extra?: Buffer;
  shorten?: number;
  ignoreRange?: boolean;
  noLength?: boolean;
  badRange?: string;
  status?: number;
  redirectTo?: string;
}

export interface RangeServer {
  url: string;
  port: number;
  requests: RangeRequest[];
  rules: Array<(info: RangeInfo) => RangeAction | undefined>;
  close(): Promise<void>;
}

export function createRangeServer(
  files: Record<string, Buffer>,
  options: { revision: string; repo?: string; redirect?: boolean; chunkBytes?: number; chunkDelayMs?: number },
): Promise<RangeServer>;

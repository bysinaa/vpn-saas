export interface XuiAuthResponse<T = unknown> {
  success: boolean;
  msg: string;
  obj: T;
}

export interface XuiSessionState {
  cookie: string | null;
  csrfToken: string | null;
  expiresAt: number | null;
  lastLoginAt: Date | null;
}

export interface XuiInbound {
  id: number;
  up: number;
  down: number;
  total: number;
  remark: string;
  enable: boolean;
  expiryTime: number;
  clientStats?: XuiClientTraffic[];
  listen?: string;
  port: number;
  protocol: string;
  settings: string;
  streamSettings?: string;
  tag?: string;
}

export interface XuiClientRequest {
  id?: string;
  flow?: string;
  email: string;
  limitIp?: number;
  totalGB?: number;
  expiryTime?: number;
  enable?: boolean;
  tgId?: string | number;
  subId?: string;
  reset?: number;
  comment?: string;
}

export interface XuiClientRecord extends XuiClientRequest {
  inboundId?: number;
  up?: number;
  down?: number;
  total?: number;
  uuid?: string;
}

export interface XuiClientTraffic {
  email: string;
  up: number;
  down: number;
  total: number;
  expiryTime: number;
  enable: boolean;
  inboundId?: number;
  subId?: string;
  reset?: number;
  id?: number;
  uuid?: string;
}

export interface XuiCreateClientInput {
  username: string;
  telegramId?: string | null;
  planId?: string | number | bigint | null;
  expireDate?: Date | string | number | null;
  trafficLimit?: bigint | number | null;
  inboundId?: number;
  inboundIds?: number[];
}

export interface XuiUpdateClientInput {
  email?: string;
  telegramId?: string | null;
  trafficLimit?: bigint | number | null;
  expireDate?: Date | string | number | null;
  status?: 'active' | 'disabled' | 'expired';
  resetTraffic?: boolean;
  inboundId?: number;
}

export interface XuiProvisionedClient {
  uuid: string;
  email: string;
  telegramId: string | null;
  planId: string | null;
  expireTimestamp: number;
  trafficQuota: number;
  inboundId: number;
  client: XuiClientRecord | null;
}

export interface XuiStatusDto {
  connected: boolean;
  panel: 'online' | 'offline' | 'degraded';
  lastSync: string | null;
  inbounds: Array<{
    id: number;
    protocol: string;
    port: number;
    remark: string;
    enabled: boolean;
  }>;
}

export interface XuiConnectionTestResult {
  ssl: boolean;
  login: boolean;
  api: boolean;
  inboundsDetected: number;
  details: string[];
}
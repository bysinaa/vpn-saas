/**
 * Panel client abstraction.
 *
 * Each VPN panel provider (Sanity, Marzban, 3X-UI, ...) implements this
 * interface so the core never depends on a specific panel's API shape.
 * The active implementation is selected via the VpnPanel.type field stored
 * per-panel in the database.
 */
export interface PanelUser {
  uuid: string;
  username: string;
  status: 'active' | 'disabled' | 'limited' | 'expired';
  usedBytes: string;
  dataLimitBytes: string | null;
  expiryMs: number | null;
  subLink: string;
  onlineProtocols?: string[];
}

export interface CreatePanelUserInput {
  username: string;
  /** Traffic limit in bytes (null = unlimited). */
  dataLimitBytes: bigint | null;
  /** Expiry timestamp in ms (null = never). */
  expireMs: number | null;
  /** Max concurrent devices. */
  deviceLimit: number;
  /** Protocols / inbounds to enable. If omitted, ALL inbounds are attached. */
  protocols?: string[];
  /** Panel group to assign the client to (e.g. "BOT"). */
  group?: string;
  /** If true, attach ALL inbounds to the client. Default true. */
  attachAllInbounds?: boolean;
}

export interface UpdatePanelUserInput {
  status?: 'active' | 'disabled' | 'limited' | 'expired';
  dataLimitBytes?: bigint | null;
  expireMs?: number | null;
  resetUsage?: boolean;
}

export interface PanelHealth {
  reachable: boolean;
  latencyMs?: number;
  version?: string;
  activeUsers?: number;
  totalUsers?: number;
  cpuUsage?: number;
  memoryUsage?: number;
}

/** Traffic data returned by the /panel/api/clients/traffic/{email} endpoint. */
export interface ClientTraffic {
  usedBytes: string; // up + down in bytes
  totalBytes: string; // total traffic limit in bytes (0 = unlimited)
  up: number; // uplink bytes
  down: number; // downlink bytes
  expiryTime: number; // epoch ms, 0 = never expires
  subId: string; // subscription ID for generating sub links
  uuid: string; // client UUID
  enable: boolean; // whether the client is enabled
}

export interface IPanelClient {
  /** Panel type code this client handles (matches VpnPanel.type). */
  readonly type: string;

  createUser(panel: PanelConnection, input: CreatePanelUserInput): Promise<PanelUser>;
  getUser(panel: PanelConnection, username: string): Promise<PanelUser | null>;
  getClientTraffic(panel: PanelConnection, email: string): Promise<ClientTraffic | null>;
  updateUser(panel: PanelConnection, username: string, input: UpdatePanelUserInput): Promise<PanelUser>;
  deleteUser(panel: PanelConnection, username: string): Promise<void>;
  resetTraffic(panel: PanelConnection, username: string): Promise<void>;
  health(panel: PanelConnection): Promise<PanelHealth>;
}

/** Connection details needed to reach a panel; sourced from VpnPanel row. */
export interface PanelConnection {
  id: bigint;
  name: string;
  type?: string;
  baseUrl: string;
  apiKey: string;
  extraConfig?: Record<string, unknown>;
}

export const PANEL_CLIENTS = Symbol('PANEL_CLIENTS');

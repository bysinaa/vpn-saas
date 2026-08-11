jest.mock('@/config', () => ({
  config: {
    xui: { timeoutMs: 20, username: 'admin', password: 'password', baseUrl: 'https://xui.test' },
  },
}));
jest.mock('@/common/proxy/proxy-http.service', () => ({
  ProxyHttpService: class ProxyHttpService {},
}));

import { XuiPanelClient } from './xui-panel.client';

const panel = {
  id: 1n,
  name: 'XUI',
  baseUrl: 'https://xui.test',
  apiKey: '',
  extraConfig: { username: 'admin', password: 'password' },
};

function response(status: number, obj: unknown, cookie?: string) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(obj),
    text: jest.fn().mockResolvedValue(JSON.stringify(obj)),
    headers: { raw: () => (cookie ? { 'set-cookie': [cookie] } : {}) },
  };
}

function clientState(email = 'client-1') {
  return {
    email,
    enable: true,
    totalGB: 1024,
    expiryTime: 1_700_000_000_000,
    limitIp: 1,
    flow: 'xtls',
    subId: 'sub-1',
    uuid: 'generated-uuid',
  };
}

function harness() {
  const proxyFetch = jest.fn();
  const client = new XuiPanelClient({ proxyFetch } as never);
  const login = () => {
    proxyFetch.mockResolvedValueOnce(
      response(200, { success: true, msg: '', obj: 'csrf' }, 'csrf=a'),
    );
    proxyFetch.mockResolvedValueOnce(
      response(200, { success: true, msg: '', obj: null }, 'session=b'),
    );
  };
  return { client, login, proxyFetch };
}

describe('XuiPanelClient Client API', () => {
  it('logs in once and reuses the authenticated session', async () => {
    const h = harness();
    h.login();
    h.proxyFetch.mockResolvedValueOnce(
      response(200, { success: true, msg: '', obj: [clientState()] }),
    );
    h.proxyFetch.mockResolvedValueOnce(
      response(200, { success: true, msg: '', obj: [clientState('client-2')] }),
    );
    await h.client.listClients(panel);
    await h.client.listClients(panel);
    expect(h.proxyFetch).toHaveBeenCalledTimes(4);
  });

  it('lists validated inbounds through the configured web base path', async () => {
    const h = harness();
    h.login();
    h.proxyFetch.mockResolvedValueOnce(
      response(200, {
        success: true,
        msg: '',
        obj: [
          {
            id: 7,
            remark: 'main',
            tag: 'main-tag',
            protocol: 'vless',
            port: 443,
            enable: true,
            expiryTime: 0,
            settings: 'never logged',
          },
        ],
      }),
    );
    const inbounds = await h.client.listInbounds({ ...panel, baseUrl: 'https://xui.test/web' });
    expect(String(h.proxyFetch.mock.calls[2][0])).toBe(
      'https://xui.test/web/panel/api/inbounds/list',
    );
    expect(inbounds).toEqual([
      {
        id: 7,
        remark: 'main',
        tag: 'main-tag',
        protocol: 'vless',
        port: 443,
        enabled: true,
        expiryTime: 0,
        clientCompatible: true,
      },
    ]);
    expect(JSON.stringify(inbounds)).not.toContain('never logged');
  });

  it('rejects malformed inbound data without exposing raw settings', async () => {
    const h = harness();
    h.login();
    h.proxyFetch.mockResolvedValueOnce(
      response(200, {
        success: true,
        msg: '',
        obj: [{ id: 'invalid', enable: true, settings: 'sensitive' }],
      }),
    );
    await expect(h.client.listInbounds(panel)).rejects.toThrow('invalid response payload');
  });

  it('adds a client without a caller-supplied protocol secret and fetches full state', async () => {
    const h = harness();
    h.login();
    h.proxyFetch.mockResolvedValueOnce(response(200, { success: true, msg: '', obj: null }));
    h.proxyFetch.mockResolvedValueOnce(
      response(200, { success: true, msg: '', obj: clientState() }),
    );
    const created = await h.client.createUser(
      { ...panel, subPort: 8443, subPath: '/custom/sub/' },
      {
        username: 'client-1',
        dataLimitBytes: 1024n,
        expireMs: 1_700_000_000_000,
        deviceLimit: 1,
        inboundIds: [11, 12],
        subId: 'sub-1',
        telegramId: '123',
      },
    );
    expect(created.uuid).toBe('generated-uuid');
    expect(created.subLink).toBe('https://xui.test:8443/custom/sub/sub-1');
    expect(JSON.parse(String(h.proxyFetch.mock.calls[2][1].body)).client).not.toHaveProperty(
      'uuid',
    );
    expect(JSON.parse(String(h.proxyFetch.mock.calls[2][1].body)).inboundIds).toEqual([11, 12]);
    expect(JSON.parse(String(h.proxyFetch.mock.calls[2][1].body)).client).toMatchObject({
      limitIp: 1,
      tgId: 123,
    });
  });

  it('supports paged lists and full-replacement updates', async () => {
    const h = harness();
    h.login();
    h.proxyFetch.mockResolvedValueOnce(
      response(200, { success: true, msg: '', obj: { total: 1, items: [clientState()] } }),
    );
    await expect(h.client.listClientsPaged(panel, 1, 20)).resolves.toMatchObject({ total: 1 });
    h.proxyFetch.mockResolvedValueOnce(
      response(200, { success: true, msg: '', obj: clientState() }),
    );
    h.proxyFetch.mockResolvedValueOnce(response(200, { success: true, msg: '', obj: null }));
    await h.client.updateUser(panel, 'client-1', {
      status: 'disabled',
      dataLimitBytes: 2048n,
      deviceLimit: 3,
      subId: 'stable-sub',
      telegramId: '456',
    });
    const body = JSON.parse(String(h.proxyFetch.mock.calls[4][1].body));
    expect(body).toMatchObject({
      email: 'client-1',
      enable: false,
      flow: 'xtls',
      totalGB: 2048,
      limitIp: 3,
      subId: 'stable-sub',
      tgId: 456,
    });
  });

  it('supports attach, detach, enable, disable, reset, and traffic adjustment', async () => {
    const h = harness();
    h.login();
    for (let i = 0; i < 6; i += 1)
      h.proxyFetch.mockResolvedValueOnce(response(200, { success: true, msg: '', obj: {} }));
    await h.client.attachClient(panel, 'client-1', [1]);
    await h.client.detachClient(panel, 'client-1', [1]);
    await h.client.bulkEnable(panel, ['client-1']);
    await h.client.bulkDisable(panel, ['client-1']);
    await h.client.resetTraffic(panel, 'client-1');
    await h.client.updateTraffic(panel, 'client-1', 2048);
    expect(h.proxyFetch.mock.calls.map((call) => String(call[0]))).toEqual(
      expect.arrayContaining([
        expect.stringContaining('/attach'),
        expect.stringContaining('/detach'),
        expect.stringContaining('/bulkEnable'),
        expect.stringContaining('/bulkDisable'),
        expect.stringContaining('/resetTraffic'),
        expect.stringContaining('/updateTraffic'),
      ]),
    );
  });

  it('returns bulk partial-skip results and supports group lifecycle', async () => {
    const h = harness();
    h.login();
    h.proxyFetch.mockResolvedValueOnce(
      response(200, {
        success: true,
        msg: '',
        obj: { created: ['client-1'], skipped: [{ email: 'client-2', reason: 'duplicate' }] },
      }),
    );
    await expect(h.client.bulkCreate(panel, [clientState()])).resolves.toMatchObject({
      skipped: [{ email: 'client-2' }],
    });
    for (let i = 0; i < 5; i += 1)
      h.proxyFetch.mockResolvedValueOnce(response(200, { success: true, msg: '', obj: [] }));
    await h.client.listGroups(panel);
    await h.client.createGroup(panel, 'group-a');
    await h.client.renameGroup(panel, 'group-a', 'group-b');
    await h.client.bulkAddGroup(panel, 'group-b', ['client-1']);
    await h.client.deleteGroup(panel, 'group-b');
  });

  it('returns subscription links and maps duplicate and malformed responses to conflicts', async () => {
    const h = harness();
    h.login();
    h.proxyFetch.mockResolvedValueOnce(
      response(200, { success: true, msg: '', obj: { links: ['https://xui.test/sub/redacted'] } }),
    );
    await expect(h.client.subscriptionLinks(panel, 'sub-1')).resolves.toEqual([
      'https://xui.test/sub/redacted',
    ]);
    h.proxyFetch.mockResolvedValueOnce(
      response(200, { success: false, msg: 'duplicate email', obj: null }),
    );
    await expect(h.client.addClient(panel, clientState())).rejects.toThrow('already exists');
    h.proxyFetch.mockResolvedValueOnce(response(200, []));
    await expect(h.client.listClients(panel)).rejects.toThrow('malformed');
  });

  it('re-authenticates exactly once for a 401 GET but never retries ambiguous POST requests', async () => {
    const h = harness();
    h.login();
    h.proxyFetch.mockResolvedValueOnce(response(401, { success: false, msg: '', obj: null }));
    h.login();
    h.proxyFetch.mockResolvedValueOnce(
      response(200, { success: true, msg: '', obj: [clientState()] }),
    );
    await h.client.listClients(panel);
    expect(h.proxyFetch).toHaveBeenCalledTimes(6);
    const destructive = harness();
    destructive.login();
    destructive.proxyFetch.mockResolvedValueOnce(
      response(401, { success: false, msg: '', obj: null }),
    );
    await expect(destructive.client.deleteClient(panel, 'client-1')).rejects.toThrow();
    expect(destructive.proxyFetch).toHaveBeenCalledTimes(3);
  });

  it('maps timeouts and does not log session or subscription secrets', async () => {
    const h = harness();
    h.login();
    h.proxyFetch.mockRejectedValueOnce(new Error('timeout'));
    await expect(h.client.listClients(panel)).rejects.toThrow('request error');
    const safe = harness();
    const logs = jest.spyOn(
      (safe.client as unknown as { logger: { log: (...args: unknown[]) => void } }).logger,
      'log',
    );
    safe.login();
    safe.proxyFetch.mockResolvedValueOnce(
      response(200, { success: true, msg: '', obj: { links: ['https://xui.test/sub/sub-1'] } }),
    );
    await safe.client.subscriptionLinks(panel, 'sub-1');
    expect(logs.mock.calls.flat().join(' ')).not.toMatch(/csrf|session=b|sub-1|generated-uuid/);
  });
});

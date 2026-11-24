/** Owner-side calls to the ShopOS hub (FastAPI). Device sync runs inside the DB worker. */

export const DEFAULT_HUB = 'http://localhost:8000';

async function req<T>(url: string, path: string, opts: { method?: string; body?: unknown; token?: string } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${url.replace(/\/$/, '')}${path}`, {
      method: opts.method ?? (opts.body ? 'POST' : 'GET'),
      headers: {
        ...(opts.body ? { 'content-type': 'application/json' } : {}),
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    throw new Error(`Cannot reach the hub at ${url}. Is it running?`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const d = (data as any).detail;
    throw new Error(typeof d === 'string' ? d : Array.isArray(d) ? d.map((x: any) => x.msg).join(', ') : `Hub error ${res.status}`);
  }
  return data as T;
}

export interface OwnerAuth {
  org_id: string;
  user_id: string;
  access_token: string;
}

export const hub = {
  health: (url: string) => req<{ status: string }>(url, '/health'),
  createOrg: (url: string, orgName: string, email: string, password: string) =>
    req<OwnerAuth>(url, '/v1/orgs', { body: { org_name: orgName, email, password } }),
  login: (url: string, email: string, password: string) => req<OwnerAuth>(url, '/v1/auth/login', { body: { email, password } }),
  enrol: (url: string, jwt: string, deviceId: string, name: string, preferredSeries?: string) =>
    req<{ device_id: string; device_token: string; series_code: string; org_id: string }>(url, '/v1/devices/enrol', {
      token: jwt,
      body: { device_id: deviceId, name, preferred_series: preferredSeries },
    }),
  devices: (url: string, jwt: string) =>
    req<{ device_id: string; name: string; series_code: string; last_seen_at: number | null; revoked_at: number | null }[]>(url, '/v1/devices', { token: jwt }),
  revoke: (url: string, jwt: string, deviceId: string) => req(url, `/v1/devices/${deviceId}/revoke`, { token: jwt, method: 'POST', body: {} }),
  pnl: (url: string, jwt: string, from: string, to: string) =>
    req<{
      branches: { branch_id: string; branch_name: string | null; income_paise: number; expense_paise: number; net_profit_paise: number }[];
      total: { income_paise: number; expense_paise: number; net_profit_paise: number };
    }>(url, `/v1/reports/pnl?from=${from}&to=${to}`, { token: jwt }),
};

export function deviceName() {
  const ua = navigator.userAgent;
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : 'Device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  return `${browser} on ${os}`;
}

const fs = require('node:fs');
const path = require('node:path');
class Store {
  constructor(root, encryption) {
    this.root = root; this.encryption = encryption; fs.mkdirSync(root, { recursive: true });
    this.file = path.join(root, 'settings.json'); this.data = { muted: false, alwaysOnTop: true, petScale: 1, petSleep: true, petSleepMinutes: 15, petWave: true, petPinch: true, petDizzy: true, petSulky: true, petFollow: true, petSwing: 1, agentMode: 'codex', startupMode: 'codex', codexModel: '', codexEffort: '', claudeModel: '', claudePermission: 'default', cwd: '', renewalDate: '', subscriptionAmount: '', budget: '' };
    try { Object.assign(this.data, JSON.parse(fs.readFileSync(this.file, 'utf8'))); } catch { /* Defaults on first run. */ }
  }
  save(patch) { Object.assign(this.data, patch); fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.data, null, 2)); fs.renameSync(this.file + '.tmp', this.file); return this.public(); }
  public() { const { apiKeyEncrypted, ...safe } = this.data; return { ...safe, hasApiKey: !!apiKeyEncrypted }; }
  key() { return this.data.apiKeyEncrypted ? this.encryption.decryptString(Buffer.from(this.data.apiKeyEncrypted, 'base64')) : null; }
  saveKey(value) {
    if (value && !this.encryption.isEncryptionAvailable()) throw new Error('Windows 密钥保护当前不可用，未保存密钥。');
    this.save({ apiKeyEncrypted: value ? this.encryption.encryptString(value).toString('base64') : undefined });
  }
}
async function getCosts(key, fetcher = fetch) {
  if (!key) throw new Error('请先在设置中保存 OpenAI 组织管理员密钥。');
  const end = Math.floor(Date.now() / 1000); const start = end - 30 * 86400;
  let page, total = 0, count = 0; const currencies = new Set(); const rows = [];
  do {
    const url = new URL('https://api.openai.com/v1/organization/costs');
    url.search = new URLSearchParams({ start_time: String(start), end_time: String(end), bucket_width: '1d', limit: '180', ...(page ? { page } : {}) });
    const response = await fetcher(url, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? '费用查询权限不足。需要有组织费用读取权限的 Admin API key。' : `官方费用服务返回 ${response.status}，请稍后刷新。`);
    const data = await response.json();
    for (const bucket of data.data || []) for (const row of bucket.results || []) {
      const value = Number(row.amount?.value); if (!Number.isFinite(value)) continue;
      currencies.add(row.amount?.currency || 'usd'); total += value;
      rows.push({ at: bucket.start_time, value, currency: row.amount?.currency || 'usd' });
    }
    page = data.has_more ? data.next_page : null;
    if (data.has_more && !page) throw new Error('官方费用返回分页信息不完整，请稍后重试。');
    if (++count > 20) throw new Error('费用分页过多，请在官方账单中查看。');
  } while (page);
  if (currencies.size > 1) throw new Error('费用包含多种币种，请在官方账单中分别查看。');
  return { total, currency: [...currencies][0] || 'usd', at: Date.now(), start, end, rows };
}
module.exports = { Store, getCosts };

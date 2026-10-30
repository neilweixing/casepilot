import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { restrictDirectory } from './permissions.ts';

export class Store {
  readonly db: DatabaseSync;
  readonly dataDir: string;
  private key: Buffer;
  constructor(dataDir: string) {
    this.dataDir = dataDir;
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    restrictDirectory(dataDir);
    this.db = new DatabaseSync(path.join(dataDir, 'casepilot.sqlite'));
    chmodSync(path.join(dataDir, 'casepilot.sqlite'), 0o600);
    this.db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS documents(kind TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(kind,id));');
    const secretDir = path.join(dataDir, 'credentials');
    mkdirSync(secretDir, { recursive: true, mode: 0o700 });
    const keyPath = path.join(secretDir, 'key');
    if (!existsSync(keyPath)) writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: 'wx' });
    this.key = readFileSync(keyPath);
    if (this.key.length !== 32) throw new Error('本地凭证密钥文件无效');
  }
  put<T extends { id: string }>(kind: string, value: T): T {
    this.db.prepare('INSERT INTO documents(kind,id,body) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body').run(kind, value.id, JSON.stringify(value));
    return value;
  }
  get<T>(kind: string, id: string): T {
    const row = this.db.prepare('SELECT body FROM documents WHERE kind=? AND id=?').get(kind, id);
    if (!row) throw Object.assign(new Error('记录不存在'), { statusCode: 404 });
    return JSON.parse(row.body as string) as T;
  }
  list<T>(kind: string): T[] { return this.db.prepare('SELECT body FROM documents WHERE kind=? ORDER BY rowid DESC').all(kind).map(row => JSON.parse(row.body as string) as T); }
  // 只按 kind+id 精确删除；返回是否删到一行，调用方据此区分“不存在”与“已删除”。
  remove(kind: string, id: string) { return this.db.prepare('DELETE FROM documents WHERE kind=? AND id=?').run(kind, id).changes > 0; }
  has(kind: string, id: string) { return this.db.prepare('SELECT 1 FROM documents WHERE kind=? AND id=?').get(kind, id) !== undefined; }
  removeSecret(ref: string) {
    if (!/^[0-9a-f-]{36}$/.test(ref)) throw new Error('无效的凭证引用');
    const file = path.join(this.dataDir, 'credentials', `${ref}.json`);
    if (existsSync(file)) unlinkSync(file);
  }
  password(value: string, ref = randomUUID()) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    writeFileSync(path.join(this.dataDir, 'credentials', `${ref}.json`), JSON.stringify({ iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }), { mode: 0o600 });
    return ref;
  }
  secret(ref: string) {
    if (!/^[0-9a-f-]{36}$/.test(ref)) throw new Error('无效的凭证引用');
    const data = JSON.parse(readFileSync(path.join(this.dataDir, 'credentials', `${ref}.json`), 'utf8'));
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(data.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(data.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(data.data, 'base64')), decipher.final()]).toString('utf8');
  }
  close() { if (this.db.isOpen) this.db.close(); }
}

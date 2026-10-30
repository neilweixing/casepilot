export class RecoveryLimit extends Error {}

export class StepRecovery {
  readonly maxAttempts: number;
  readonly timeoutMs: number;
  failures = 0;
  private spent = 0;
  private waitingSince: number | undefined;
  private needsSnapshot = false;
  constructor(maxAttempts: number, timeoutMs: number) { this.maxAttempts = maxAttempts; this.timeoutMs = timeoutMs; }
  get active() { return this.waitingSince !== undefined; }
  remaining(now = Date.now()) { return this.timeoutMs - this.spent - (this.waitingSince === undefined ? 0 : now - this.waitingSince); }
  check(now = Date.now()) { if (this.active && this.remaining(now) <= 0) throw new RecoveryLimit('定位恢复时间已耗尽，保留原始错误，未重跑用例'); }
  failed(now = Date.now()) {
    this.check(now);
    if (++this.failures > this.maxAttempts) throw new RecoveryLimit(`定位恢复次数已耗尽（最多 ${this.maxAttempts} 次），保留原始错误，未重跑用例`);
    this.waitingSince ??= now; this.needsSnapshot = true;
    return this.failures;
  }
  snapshot(now = Date.now()) { this.check(now); this.needsSnapshot = false; }
  beforeTarget(now = Date.now()) { this.check(now); if (this.needsSnapshot) throw new Error('定位失败后必须先重新获取快照，再选择最新目标'); }
  resolved(now = Date.now()) {
    this.check(now);
    if (this.waitingSince !== undefined) this.spent += now - this.waitingSince;
    this.waitingSince = undefined; this.needsSnapshot = false;
  }
  pause(duration: number) { if (this.waitingSince !== undefined) this.waitingSince += duration; }
}

export class MutationFence {
  pending = false;
  private sent = new Set<string>();
  begin(action: string, identity: string) {
    if (this.pending) throw new Error('上次操作结果不确定，禁止追加或重放写操作');
    const key = `${action}:${identity}`;
    if (['click', 'press'].includes(action) && this.sent.has(key)) throw new Error('同一步骤的点击或按键已发出，禁止重复；请只读检查结果');
    this.sent.add(key); this.pending = true;
  }
  acknowledge() { this.pending = false; }
}

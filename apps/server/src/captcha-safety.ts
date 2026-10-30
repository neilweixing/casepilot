export class CaptchaLimit extends Error {}

export class CaptchaBudget {
  readonly maxAttempts: number;
  private captures = 0;
  private submissions = 0;
  private refreshes = 0;
  private latest: { id: string; url: string; fingerprint: string; used: boolean } | undefined;
  private usedImages = new Set<string>();
  constructor(maxAttempts: number) { this.maxAttempts = maxAttempts; }
  get counts() { return { captures: this.captures, submissions: this.submissions, refreshes: this.refreshes }; }
  get submittedCurrentImage() { return this.latest?.used === true; }
  invalidate() { this.latest = undefined; }
  capture(id: string, url: string, fingerprint = id) {
    if (this.captures >= this.maxAttempts) throw new CaptchaLimit(`图片验证码识别次数已耗尽（最多 ${this.maxAttempts} 次），请检查测试入口后继续`);
    if (this.latest?.used || this.usedImages.has(fingerprint)) throw new Error('当前验证码图片已提交，先确认失败并刷新，不能重新截图后重复提交');
    this.captures++; this.latest = { id, url, fingerprint, used: false };
  }
  submit(id: string, url: string, sent: boolean) {
    if (!this.latest || this.latest.id !== id || this.latest.url !== url) throw new Error('验证码图片已过期，请重新观察当前图片');
    if (this.latest.used) throw new Error('当前验证码图片已提交，不得重复；请只读检查结果，明确失败后刷新');
    if (!sent) throw new Error('验证码图片未实际发送给模型，不能提交识别值');
    if (this.submissions >= this.maxAttempts) throw new CaptchaLimit('图片验证码提交次数已耗尽');
    this.latest.used = true; this.usedImages.add(this.latest.fingerprint); return ++this.submissions;
  }
  refresh(confirmedFailure = false) {
    if (this.refreshes >= this.maxAttempts - 1 || this.captures >= this.maxAttempts) throw new CaptchaLimit('图片验证码刷新次数已耗尽，请检查测试入口后继续');
    if (this.submittedCurrentImage && !confirmedFailure) throw new Error('上次登录尚未明确验证码失败，不能刷新后重新提交');
    this.invalidate(); return ++this.refreshes;
  }
}

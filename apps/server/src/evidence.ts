import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import type { Evidence, ExpectationId, ExpectationResult, SmokeResult } from '../../../packages/contracts/src/smoke.ts';
import { smokeCase } from '../../../packages/contracts/src/smoke.ts';
import { redact } from './config.ts';

export class EvidenceStore {
  readonly evidence: Evidence[] = [];
  readonly expectations: ExpectationResult[] = [];
  readonly errors: string[] = [];
  readonly directory: string;
  readonly runId: string;
  private secrets: string[];
  constructor(runId: string, dataDir: string, secrets: string[]) {
    this.runId = runId;
    this.secrets = secrets;
    this.directory = path.join(dataDir, 'runs', runId);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.writeJson('case.json', smokeCase);
  }
  writeJson(filename: string, data: unknown) {
    writeFileSync(path.join(this.directory, filename), redact(JSON.stringify(data, null, 2), this.secrets) + '\n', { mode: 0o600 });
  }
  event(type: string, data: unknown) {
    appendFileSync(path.join(this.directory, 'events.jsonl'), redact(JSON.stringify({ runId: this.runId, caseId: smokeCase.id, timestamp: new Date().toISOString(), type, data }), this.secrets) + '\n', { mode: 0o600 });
  }
  add(kind: Evidence['kind'], data: unknown, association: { stepId?: string; expectationId?: ExpectationId } = {}) {
    const id = `e${this.evidence.length + 1}`;
    const filename = `${id}.${kind === 'screenshot' ? 'png' : 'json'}`;
    if (kind === 'screenshot') {
      if (!Buffer.isBuffer(data) || !data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) throw new Error('截图不是有效 PNG');
      writeFileSync(path.join(this.directory, filename), data, { mode: 0o600 });
    } else this.writeJson(filename, data);
    this.evidence.push({ id, runId: this.runId, caseId: smokeCase.id, kind, path: filename, timestamp: new Date().toISOString(), ...association });
    return id;
  }
}

export function finalizeResult(runId: string, expectations: ExpectationResult[], evidence: Evidence[], errors: string[], cancelled = false): SmokeResult {
  const issues = [...errors];
  const validated = expectations.filter(item => {
    const requiredKinds = item.expectationId === 'visual-code' ? ['visual', 'screenshot'] : item.status === 'FAILED' ? ['observation'] : ['observation', 'screenshot'];
    const linked = item.evidenceIds.map(id => evidence.find(e => e.id === id && e.runId === runId && e.caseId === smokeCase.id && (!e.expectationId || e.expectationId === item.expectationId))).filter(e => e !== undefined);
    const valid = linked.length === item.evidenceIds.length && requiredKinds.every(kind => linked.some(e => e.kind === kind));
    if (!valid) issues.push(`${item.expectationId} 缺少本次运行的有效证据`);
    return valid;
  });
  if (!cancelled) for (const item of smokeCase.expectations) {
    if (validated.filter(e => e.expectationId === item.id).length !== 1) issues.push(`${item.id} 必须有且仅有一项有效验证结果`);
  }
  const failed = validated.some(e => e.status === 'FAILED');
  const status = failed ? 'FAILED' : cancelled ? 'CANCELLED' : issues.length || validated.some(e => e.status === 'ERROR') ? 'ERROR' : 'PASSED';
  return { runId, caseId: smokeCase.id, status, expectations, evidence, errors: issues };
}

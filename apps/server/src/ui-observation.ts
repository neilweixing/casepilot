interface Rect { x: number; y: number; width: number; height: number; bottom: number; right: number; visible: boolean }
interface ElementObservation {
  url: string; exists: boolean; text: string; value: string; rect: Rect | null;
  viewport: { width: number; height: number; scrollX: number; scrollY: number };
}
type Evaluate = (expression: string, target?: string) => Promise<Record<string, unknown>>;

// 只生成固定的读取函数；模型只能提供目标，不能提供页面脚本。
const inspectElement = `(element) => {
  const r=element?.getBoundingClientRect(), s=element ? getComputedStyle(element) : null;
  return {url:location.href,exists:!!element,text:element?.textContent?.slice(0,12000)||'',value:element?.value||'',
    rect:r?{x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom,right:r.right,
      visible:r.width>0&&r.height>0&&r.x>=0&&r.y>=0&&r.right<=innerWidth&&r.bottom<=innerHeight&&s.visibility==='visible'&&s.display!=='none'&&Number(s.opacity)>0}:null,
    viewport:{width:innerWidth,height:innerHeight,scrollX,scrollY}};
}`;

export async function observeUI(evaluate: Evaluate, target: string, kind: string, otherTarget?: string) {
  if (kind === 'position' && !otherTarget) throw new Error('位置观察需要 target 和 otherTarget 两个目标');
  const read = async (value: string) => {
    if (/^(?:f\d+)?e\d+$/.test(value)) return await evaluate(inspectElement, value) as unknown as ElementObservation;
    const expression = `() => { const elements=document.querySelectorAll(${JSON.stringify(value)}); if(elements.length>1) throw new Error('目标匹配多个元素，请使用最新快照的唯一 ref'); return (${inspectElement})(elements[0]); }`;
    return await evaluate(expression) as unknown as ElementObservation;
  };
  const data = await read(target);
  let other: ElementObservation | undefined;
  if (kind === 'position') {
    other = await read(otherTarget!);
    if (!data.rect || !other.rect) throw new Error('位置观察需要两个实际存在的元素，请使用最新快照的 ref');
    const otherViewport = other.viewport;
    if (data.url !== other.url || Object.keys(data.viewport).some(key => data.viewport[key as keyof ElementObservation['viewport']] !== otherViewport[key as keyof ElementObservation['viewport']])) {
      throw new Error('页面或视口在观察期间发生变化，请重新观察，不能据此判断位置');
    }
  }
  const a = data.rect, b = other?.rect;
  return { ...data, otherRect: b || null, below: !!a && !!b && a.y >= b.bottom, above: !!a && !!b && a.bottom <= b.y, left: !!a && !!b && a.right <= b.x, right: !!a && !!b && a.x >= b.right };
}

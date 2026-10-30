import { createHash } from 'node:crypto';

// 每次运行的校验码不同，仅用于可控页面的图像能力验收。
export function visualCodeForRun(runId: string) {
  return String(parseInt(createHash('sha256').update(runId).digest('hex').slice(0, 8), 16) % 10000).padStart(4, '0');
}

export function fixturePage(runId: string, reversed: boolean) {
  const name = '<label>姓名<input name="name" autocomplete="off" required></label>';
  const date = '<label>预计启动日期<input name="startDate" placeholder="YYYY-MM-DD" autocomplete="off" required></label>';
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>CasePilot M1 可控表单</title>
<style>body{font:18px system-ui;max-width:640px;margin:36px auto;color:#17243b;background:#f6f8fc}main{padding:28px;background:white;border-radius:16px}label{display:block;margin:20px 0}input{display:block;width:90%;padding:12px;margin-top:8px;font:inherit}button{padding:12px 24px;font:inherit}canvas{display:block;background:#e9efff;margin:20px 0}output{display:block;margin-top:20px}</style>
<main data-casepilot-run="${runId}"><h1>M1 可控表单</h1><p>填写表单后点击一次提交，再检查结果与字段位置。</p>
<form>${reversed ? date + name : name + date}<button type="submit">提交</button></form>
<output role="status" data-submissions="0">尚未提交</output>
<p>四位视觉校验码（请从图像中读取）：</p><canvas width="300" height="90" aria-label="四位视觉校验码图像"></canvas></main>
<script>
const canvas=document.querySelector('canvas'),ctx=canvas.getContext('2d');
ctx.fillStyle='#e9efff';ctx.fillRect(0,0,300,90);ctx.fillStyle='#142e6f';ctx.font='bold 54px monospace';ctx.fillText('${visualCodeForRun(runId)}',70,63);
document.querySelector('form').addEventListener('submit',event=>{event.preventDefault();const form=event.currentTarget,output=document.querySelector('output');output.dataset.submissions=String(Number(output.dataset.submissions)+1);output.textContent='已提交：'+form.elements.name.value+' / '+form.elements.startDate.value;});
</script></html>`;
}

// 固定只读观察；不接受模型提供的脚本，也不改变页面状态。
export const observeFunction = `() => {
  const rect = selector => {
    const element = document.querySelector(selector);
    if (!element) return null;
    const r = element.getBoundingClientRect(), style = getComputedStyle(element);
    return { x:r.x, y:r.y, width:r.width, height:r.height, bottom:r.bottom,
      visible:r.width>0 && r.height>0 && r.x>=0 && r.y>=0 && r.right<=innerWidth && r.bottom<=innerHeight && style.visibility==='visible' && style.display!=='none' && Number(style.opacity)>0 };
  };
  return { runId:document.querySelector('main')?.getAttribute('data-casepilot-run'), url:location.href,
    text:document.querySelector('output')?.textContent, submissions:Number(document.querySelector('output')?.getAttribute('data-submissions')),
    name:document.querySelector('input[name="name"]')?.value, startDate:document.querySelector('input[name="startDate"]')?.value,
    nameRect:rect('input[name="name"]'), dateRect:rect('input[name="startDate"]') };
}`;

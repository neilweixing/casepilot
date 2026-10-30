import { useLayoutEffect, useRef, useState, useEffect } from 'react';
import type { Run } from '../../../packages/contracts/src/p0.ts';

export function ExecutionLog({ events, running }: { events: Run['events']; running: boolean }) {
  const viewport = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);
  const scrollTimer = useRef<number | undefined>(undefined);
  const [following, setFollowing] = useState(true);
  const [scrolling, setScrolling] = useState(false);
  const [atStart, setAtStart] = useState(true);
  const latest = events.at(-1)?.seq;

  useLayoutEffect(() => {
    if (followingRef.current && viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight;
  }, [latest]);

  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      if (followingRef.current) element.scrollTop = element.scrollHeight;
    });
    observer.observe(element);
    const list = element.querySelector('ol');
    if (list) observer.observe(list);
    return () => observer.disconnect();
  }, [events.length === 0]);

  useEffect(() => () => window.clearTimeout(scrollTimer.current), []);

  const trackScroll = () => {
    const element = viewport.current;
    if (!element) return;
    const atLatest = element.scrollHeight - element.clientHeight - element.scrollTop <= 24;
    followingRef.current = atLatest;
    setFollowing(atLatest);
    setAtStart(element.scrollTop < 4);
    setScrolling(true);
    window.clearTimeout(scrollTimer.current);
    scrollTimer.current = window.setTimeout(() => setScrolling(false), 900);
  };

  const returnToLatest = () => {
    followingRef.current = true;
    setFollowing(true);
    if (viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight;
  };

  return <aside className="event-panel panel" aria-labelledby="execution-log-title">
    <div className="event-panel-heading">
      <h3 id="execution-log-title">执行记录</h3>
      <span className="event-follow-state" data-following={following}>
        {running && following && <i aria-hidden="true" />}
        {following ? running ? '跟随最新' : '最新记录' : '浏览历史'}
      </span>
    </div>
    <p className="caption">按时间保留执行过程与异常</p>
    <div ref={viewport} className="event-log-scroll" data-scrolling={scrolling} data-at-start={atStart} onScroll={trackScroll} tabIndex={0} role="log" aria-label="执行记录，可滚动查看历史" aria-live={following && running ? 'polite' : 'off'} aria-relevant="additions">
      {events.length ? <ol>{events.map((event, index) => <li key={event.seq} data-latest={index === events.length - 1}>
        <time dateTime={event.timestamp}>{new Date(event.timestamp).toLocaleTimeString('zh-CN', { hour12: false })}</time>
        <p>{event.message}</p>
      </li>)}</ol> : <p className="event-empty">任务开始后，记录会显示在这里</p>}
    </div>
    <div className="event-panel-footer">
      <span>共 {events.length} 条记录</span>
      {following ? <span>{running ? '自动跟随中' : '已是最新'}</span> : <button onClick={returnToLatest}>回到最新 <span aria-hidden="true">↓</span></button>}
    </div>
  </aside>;
}

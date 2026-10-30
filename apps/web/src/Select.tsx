import React, { Children, isValidElement, type ReactNode } from 'react';
import * as Primitive from '@radix-ui/react-select';

interface Props {
  value: string | number;
  onChange(event: { target: { value: string } }): void;
  children: ReactNode;
  'aria-label'?: string;
  disabled?: boolean;
  required?: boolean;
  name?: string;
}
const empty = '__casepilot_empty_option__';
function Chevron({ up = false }: { up?: boolean }) { return <svg width="15" height="15" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d={up ? 'm5 12 5-5 5 5' : 'm5 8 5 5 5-5'} stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>; }

export function Select({ value, onChange, children, disabled, required, name, 'aria-label': ariaLabel }: Props) {
  const options = Children.toArray(children).filter(isValidElement).map(child => child as React.ReactElement<{ value: string | number; children: ReactNode; disabled?: boolean }>);
  return <Primitive.Root value={String(value) || empty} onValueChange={selected => onChange({ target: { value: selected === empty ? '' : selected } })} disabled={disabled} required={required} name={name}>
    <Primitive.Trigger className="select-trigger" aria-label={ariaLabel} data-empty={String(value) === ''}>
      <span className="select-value"><Primitive.Value /></span><Primitive.Icon className="select-chevron"><Chevron /></Primitive.Icon>
    </Primitive.Trigger>
    <Primitive.Portal><Primitive.Content className="select-content" position="popper" sideOffset={7} align="start" collisionPadding={16}>
      <Primitive.ScrollUpButton className="select-scroll"><Chevron up /></Primitive.ScrollUpButton>
      <Primitive.Viewport className="select-viewport">{options.map(option => <Primitive.Item key={String(option.props.value)} value={String(option.props.value) || empty} disabled={option.props.disabled} className="select-item" data-empty={String(option.props.value) === ''}>
        <Primitive.ItemText>{option.props.children}</Primitive.ItemText><Primitive.ItemIndicator className="select-check"><svg width="15" height="15" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m4 10 4 4 8-8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg></Primitive.ItemIndicator>
      </Primitive.Item>)}</Primitive.Viewport>
      <Primitive.ScrollDownButton className="select-scroll"><Chevron /></Primitive.ScrollDownButton>
    </Primitive.Content></Primitive.Portal>
  </Primitive.Root>;
}

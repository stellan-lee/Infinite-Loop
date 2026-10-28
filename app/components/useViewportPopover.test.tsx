import { afterEach, expect, test } from 'bun:test';
import { act, cleanup, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { useViewportPopover } from './useViewportPopover';

function Harness() {
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const { panelRef, panelStyle, portal } = useViewportPopover<HTMLDivElement>(true, anchorRef, {
    minWidth: 280,
    maxHeight: 200,
  });
  return <>
    <button ref={anchorRef} data-testid="anchor">Open</button>
    {portal(<div ref={panelRef} style={{ ...panelStyle, border: '2px solid' }} role="listbox">Options</div>)}
  </>;
}

const originalRect = HTMLElement.prototype.getBoundingClientRect;
const originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight');
const originalWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth');
const originalHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight');

afterEach(() => {
  cleanup();
  HTMLElement.prototype.getBoundingClientRect = originalRect;
  if (originalScrollHeight) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', originalScrollHeight);
  else Reflect.deleteProperty(HTMLElement.prototype, 'scrollHeight');
  if (originalWidth) Object.defineProperty(window, 'innerWidth', originalWidth);
  else Reflect.deleteProperty(window, 'innerWidth');
  if (originalHeight) Object.defineProperty(window, 'innerHeight', originalHeight);
  else Reflect.deleteProperty(window, 'innerHeight');
});

test('places a clipped edge menu inside the viewport and flips near the bottom', () => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 320 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 400 });
  HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.dataset.testid === 'anchor') {
      return { left: 4, right: 104, top: 370, bottom: 390, width: 100, height: 20 } as DOMRect;
    }
    return { left: 0, right: 280, top: 0, bottom: 0, width: 280, height: 0 } as DOMRect;
  };
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get() { return 180; } });

  render(<Harness />);
  const panel = screen.getByRole('listbox');
  expect(panel.parentElement).toBe(document.body);
  expect(panel.style.left).toBe('8px');
  expect(panel.style.width).toBe('280px');
  expect(panel.style.top).toBe('182px');
  expect(panel.style.maxHeight).toBe('200px');
  expect(panel.style.visibility).toBe('visible');

  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 240 });
  act(() => window.dispatchEvent(new Event('resize')));
  expect(panel.style.width).toBe('224px');
});

test('keeps the panel inside a short viewport when its anchor scrolls out of view', () => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 320 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 200 });
  let anchorTop = -500;
  HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.dataset.testid === 'anchor') {
      return { left: 4, right: 104, top: anchorTop, bottom: anchorTop + 20, width: 100, height: 20 } as DOMRect;
    }
    return { left: 0, right: 280, top: 0, bottom: 0, width: 280, height: 0 } as DOMRect;
  };
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get() { return 300; } });

  render(<Harness />);
  const panel = screen.getByRole('listbox');
  expect(Number.parseFloat(panel.style.top)).toBeGreaterThanOrEqual(8);
  expect(Number.parseFloat(panel.style.top) + Number.parseFloat(panel.style.maxHeight)).toBeLessThanOrEqual(192);

  anchorTop = 500;
  act(() => document.dispatchEvent(new Event('scroll')));
  expect(Number.parseFloat(panel.style.top)).toBeGreaterThanOrEqual(8);
  expect(Number.parseFloat(panel.style.top) + Number.parseFloat(panel.style.maxHeight)).toBeLessThanOrEqual(192);

  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 120 });
  act(() => window.dispatchEvent(new Event('resize')));
  expect(Number.parseFloat(panel.style.top)).toBeGreaterThanOrEqual(8);
  expect(Number.parseFloat(panel.style.top) + Number.parseFloat(panel.style.maxHeight)).toBeLessThanOrEqual(112);
});

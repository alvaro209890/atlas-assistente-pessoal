import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(cleanup);

class WebGLRenderingContextStub {}
class WebGL2RenderingContextStub extends WebGLRenderingContextStub {}

Object.defineProperty(globalThis, 'WebGLRenderingContext', { value: WebGLRenderingContextStub, writable: true });
Object.defineProperty(globalThis, 'WebGL2RenderingContext', { value: WebGL2RenderingContextStub, writable: true });

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  }),
});

Element.prototype.scrollIntoView = () => undefined;

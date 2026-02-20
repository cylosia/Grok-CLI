declare module 'marked-terminal' {
  import type { Renderer } from 'marked';

  interface TerminalRendererConstructor {
    new (options?: Record<string, unknown>): Renderer;
  }

  const TerminalRenderer: TerminalRendererConstructor;
  export default TerminalRenderer;
}

import { validateEndConfig, type NodeExecutor } from '../../shared/workflow';

/**
 * End node — terminal marker. The engine handles run-settling (final status,
 * scope snapshot, run_finished event) when it reaches an end node. Copy named
 * values before settlement so both success and failure retain final outputs.
 */
export const endExecutor: NodeExecutor = {
  async execute(ctx) {
    validateEndConfig(ctx.config, ctx.nodeId ?? 'end');
    const outputs: Record<string, unknown> = {};
    for (const [name, ref] of Object.entries(ctx.config.outputs ?? {})) {
      let value: unknown = ctx.scope;
      for (const segment of ref.split('.')) {
        if (value === null || typeof value !== 'object' ||
            !Object.hasOwn(value, segment)) {
          value = undefined;
          break;
        }
        value = (value as Record<string, unknown>)[segment];
      }
      outputs[name] = value ?? null;
    }
    return { outputs, branch: 'next' };
  },
};

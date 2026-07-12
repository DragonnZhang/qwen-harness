/**
 * @qwen-harness/tool-worker
 *
 * The capability-scoped RPC boundary and the sandboxed handlers.
 *
 * `handlers.ts` is the ONLY place in the product where model-initiated filesystem, shell, and Git
 * I/O actually executes, and it runs exclusively inside the sandboxed worker process
 * (`worker-main.ts`). The runtime holds tool *definitions*; it cannot hold a handler, because the
 * handler type does not exist on its side of the boundary.
 *
 * The RPC carries capability HANDLES, not host paths: the runtime says
 * `{handle: 'workspace', relative: 'a.ts'}`, never `/home/user/project/a.ts`. A confused-deputy
 * bug in the runtime therefore cannot ask the worker to touch something outside the workspace —
 * there is no way to say it.
 */

export * from './rpc.ts';
export {
  resolveScoped,
  isBinary,
  detectLineEnding,
  digest,
  unifiedDiff,
  handleRequest,
  WorkerFailure,
} from './handlers.ts';
export type { HandleRoots, HandlerContext } from './handlers.ts';

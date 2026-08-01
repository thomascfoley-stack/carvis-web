import { recordFailure } from "./db";

/**
 * The graph module: every fallible step in the pipeline is a *node*, and one
 * wrapper gives all of them the same cross-cutting behaviour — timing,
 * fingerprinted failure capture with a replayable sample, and an optional
 * one-shot retry. Write only the node body; the plumbing exists exactly once.
 *
 * Two kinds of failure, deliberately distinct:
 *
 *   - Thrown: the node crashed. Captured and rethrown — the caller's error
 *     handling still runs.
 *   - Soft: the node *returned*, but returned something the `soft` check
 *     recognises as a broken promise (a "That failed: …" tool sentence, an
 *     `{ok:false}` result). Captured and returned unchanged, because callers
 *     already know how to hand those onward.
 *
 * User-config states ("no key yet", "browser TTS selected") must not be
 * reported by `soft` — the failures table is a defect queue for the fixer
 * agent, not an activity log. One noisy node buries every real bug.
 */

export type NodeContext = { signal?: AbortSignal };

export type SoftFailure = { class: string; message: string };

export type NodeDef<I, O> = {
  /** Name in the failures table. A function when one body serves many variants. */
  id: string | ((input: I) => string);
  run: (input: I, ctx: NodeContext) => Promise<O>;
  /** Inspect a completed run; null means healthy. */
  soft?: (output: O, input: I) => SoftFailure | null;
  /** Retry the run once when a failure message looks transient. */
  retryOnce?: (message: string) => boolean;
  /**
   * The reproduction stored beside the failure. Return only what the fixer
   * agent needs — never credentials, and never raw user prose when a length
   * or an id carries the same diagnostic weight.
   */
  sample?: (input: I) => unknown;
};

export function defineNode<I, O>(def: NodeDef<I, O>) {
  return async function execute(input: I, ctx: NodeContext = {}): Promise<O> {
    const id = typeof def.id === "function" ? def.id(input) : def.id;
    const started = Date.now();

    // Awaited, not fire-and-forget: on serverless the runtime freezes the
    // instance the moment the response settles, and a dangling insert loses
    // the race exactly on the cold instances where a capture matters most.
    // recordFailure swallows its own errors, so awaiting is safe.
    const capture = (errorClass: string, message: string) =>
      recordFailure({
        node: id,
        errorClass,
        message,
        input: { ms: Date.now() - started, repro: def.sample?.(input) ?? null },
      });

    for (let attempt = 1; ; attempt++) {
      try {
        const out = await def.run(input, ctx);
        const bad = def.soft?.(out, input) ?? null;
        if (!bad) return out;
        // A hang-up is the user's choice, not a defect — even when the body
        // swallowed the AbortError and dressed it up as an {ok:false} result.
        if (ctx.signal?.aborted || /abort/i.test(bad.message)) return out;
        if (attempt === 1 && def.retryOnce?.(bad.message)) continue;
        await capture(bad.class, bad.message);
        return out;
      } catch (e: any) {
        if (e?.name === "AbortError" || ctx.signal?.aborted) throw e;
        const message = String(e?.message ?? e).slice(0, 500);
        if (attempt === 1 && def.retryOnce?.(message)) continue;
        await capture(e?.name && e.name !== "Error" ? e.name : "Error", message);
        throw e;
      }
    }
  };
}

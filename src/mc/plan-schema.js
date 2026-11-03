// The names and the model words mc checks, shared by goals and the runner.
//
// This was the schema of a project's plan, and its validators. Projects went
// on 2026-11-03 (goal mc/projects-to-goals): a goal's file is checked by
// goals.js, with the criterion and document validators of criteria.js that the
// plan shared. What is left here are the words both used.

/** A model as a word: what `mc model` and the runner accept before asking whether it exists. */
export const MODEL_RE = /^[a-z][a-z0-9._-]{0,63}$/u;

/** A programme's, a goal's or an old project's name. */
export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/u;

/**
 * claude's `--effort` levels, as `claude --help` lists them (2.1.268). A codex
 * session's effort is the same word, passed as `model_reasoning_effort`: the
 * installed codex (0.151.0) lists these names among its own.
 */
export const EFFORT_LEVELS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);

/** The models that run on claude, and the ones that run on codex. A model belongs to one tool. */
export const CLAUDE_MODELS = Object.freeze(['haiku', 'opus']);
export const CODEX_MODELS = Object.freeze(['gpt-6.1-sol', 'gpt-6-luna']);

/**
 * The work classes (ruling 59): `fast` and `large` for a build, which mc
 * resolves to a model when the session starts, and `review`, the review
 * session's class.
 */
export const WORK_CLASSES = Object.freeze(['fast', 'large']);
export const REVIEW_CLASS = 'review';

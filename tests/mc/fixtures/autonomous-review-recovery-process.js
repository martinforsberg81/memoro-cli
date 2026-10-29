/** Native supervisor/transport fixture. Its parent can disappear at each durable
 * boundary without inventing successful terminal facts in a test double. */
import assert from 'node:assert/strict';
import { beginReviewProcess, streamReviewSession } from '../../../src/mc/autonomous-review-process.js';
import { completeAutonomousReview } from '../../../src/mc/autonomous-review.js';

const [input, boundary, mode = 'complete'] = process.argv.slice(2);
const options = JSON.parse(input);
beginReviewProcess(options);
if (boundary !== 'spawn-intent') {
  const script = mode === 'no-result' ? 'process.exit(0)'
    : mode === 'tools' ? 'console.log(JSON.stringify({type:"item.started",item:{id:"orphan",type:"command_execution"}}));console.log(JSON.stringify({type:"turn.completed"}))'
      : 'console.log(JSON.stringify({type:"turn.completed"}))';
  const result = await streamReviewSession({ bin: process.execPath, args: ['-e', script], cwd: options.checkout,
    reviewProcess: { options, tool: 'codex' } });
  assert.equal(result.process_closed, true);
  // An actual supervisor exit skips claim cleanup as well as state release.
  if (boundary === 'report') completeAutonomousReview(options, null, { record: () => process.exit(0) });
  if (boundary === 'state') completeAutonomousReview(options, null);
}

export function renderIntro({ version, codingSessionId, repo, branch, label = null, tool = null }) {
  const toolSeg = tool ? `  ·  \x1b[35m${tool}\x1b[0m` : '';
  const coordinatorCommand = tool && /claude/i.test(tool)
    ? ['/memoro-coordinator', 'manage other sessions from inside Claude']
    : ['mc sessions watch', 'review local broker sessions'];
  const headline = label
    ? `  \x1b[1mmc\x1b[0m \x1b[2m${version}\x1b[0m${toolSeg}  ·  \x1b[33m${label}\x1b[0m  ·  ${repo} \x1b[2m(${branch})\x1b[0m`
    : `  \x1b[1mmc\x1b[0m \x1b[2m${version}\x1b[0m${toolSeg}  ·  ${repo} \x1b[2m(${branch})\x1b[0m`;
  return [
    '',
    headline,
    `  \x1b[2msession\x1b[0m  ${codingSessionId}`,
    '',
    `  \x1b[36m${coordinatorCommand[0]}\x1b[0m   ${coordinatorCommand[1]}`,
    `  \x1b[36m/mc map\x1b[0m             reconcile MEMORO.md from this session`,
    `  \x1b[36mmc --help\x1b[0m              cli reference`,
    '',
    '',
  ].join('\n');
}

export function renderIntro({ version, codingSessionId, repo, branch, label = null, tool = null }) {
  const toolSeg = tool ? `  ·  \x1b[35m${tool}\x1b[0m` : '';
  const mapCommand = tool && /codex/i.test(tool) ? '/mc map' : '/memoro-map';
  const headline = label
    ? `  \x1b[1mmc\x1b[0m \x1b[2m${version}\x1b[0m${toolSeg}  ·  \x1b[33m${label}\x1b[0m  ·  ${repo} \x1b[2m(${branch})\x1b[0m`
    : `  \x1b[1mmc\x1b[0m \x1b[2m${version}\x1b[0m${toolSeg}  ·  ${repo} \x1b[2m(${branch})\x1b[0m`;
  return [
    '',
    headline,
    `  \x1b[2msession\x1b[0m  ${codingSessionId}`,
    '',
    `  \x1b[36m/memoro-coordinator\x1b[0m   manage other sessions from inside your tool`,
    `  \x1b[36m${mapCommand}\x1b[0m             reconcile MEMORO.md from this session`,
    `  \x1b[36mmc --help\x1b[0m              cli reference`,
    '',
    '',
  ].join('\n');
}

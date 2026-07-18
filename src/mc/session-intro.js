export function renderIntro({ version, codingSessionId, repo, branch, label = null, tool = null }) {
  const toolSeg = tool ? `  ·  \x1b[35m${tool}\x1b[0m` : '';
  const headline = label
    ? `  \x1b[1mmc\x1b[0m \x1b[2m${version}\x1b[0m${toolSeg}  ·  \x1b[33m${label}\x1b[0m  ·  ${repo} \x1b[2m(${branch})\x1b[0m`
    : `  \x1b[1mmc\x1b[0m \x1b[2m${version}\x1b[0m${toolSeg}  ·  ${repo} \x1b[2m(${branch})\x1b[0m`;
  return [
    '',
    headline,
    `  \x1b[2msession\x1b[0m  ${codingSessionId}`,
    '',
    `  \x1b[2mterminal\x1b[0m`,
    `  \x1b[36mmc sessions watch\x1b[0m   review local broker sessions`,
    `  \x1b[36mmc --help\x1b[0m           cli reference`,
    '',
    `  \x1b[2mLLM session\x1b[0m`,
    `  \x1b[36mmc coding-profile read\x1b[0m  inspect your approved work method`,
    '',
    '',
  ].join('\n');
}

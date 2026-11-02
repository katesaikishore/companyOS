import { buildItem, type ConnectorItem } from './types';

/**
 * Reads the output of the Git history command used by the git connector:
 *
 *   git log -z --date=iso-strict --pretty=format:%H%x1f%aI%x1f%s%x1e --name-only
 *
 * Each commit is a header, the hash, the author date and the subject, separated by unit separators (0x1f) and closed by a
 * record separator (0x1e), followed by the names of the changed files, each ended by NUL. The desktop app runs that
 * command, and this module reads its output. Items come back in the order of the output, which for git log is newest
 * first.
 *
 * Each commit is one item: the title is the subject, the ts is the commit date, and the text is the list of changed files,
 * one per line. A commit lists at most 50 files, and the text says how many more changed files were not listed. sourceId
 * is the commit hash. A commit whose date cannot be read is skipped.
 */

/** The most changed file names one commit lists. */
export const GIT_LOG_FILE_LIMIT = 50;

/** A commit header: the hash, the date and the subject, closed by the record separator. */
const COMMIT_HEADER = /([0-9a-f]{40}|[0-9a-f]{64})\x1f([^\x1f\x1e\0]*)\x1f([^\x1e\0]*)\x1e/g;

export function parseGitLog(output: string): ConnectorItem[] {
  const headers = [...output.matchAll(COMMIT_HEADER)];
  const items: ConnectorItem[] = [];
  headers.forEach((header, index) => {
    const [, hash = '', date = '', subject = ''] = header;
    const start = (header.index ?? 0) + header[0].length;
    const end = headers[index + 1]?.index ?? output.length;
    const files = output
      .slice(start, end)
      .split('\0')
      .map((name) => name.replace(/^\n+|\n+$/g, ''))
      .filter((name) => name !== '');

    const shown = files.slice(0, GIT_LOG_FILE_LIMIT);
    const rest = files.length - shown.length;
    const lines = rest > 0 ? [...shown, `${rest} more changed ${rest === 1 ? 'file' : 'files'} not listed.`] : shown;

    const item = buildItem({
      source: 'git',
      sourceId: hash,
      ts: Date.parse(date),
      title: subject,
      text: lines.join('\n'),
    });
    if (item) items.push(item);
  });
  return items;
}

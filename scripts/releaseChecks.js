/** A release needs a Prerelease run that built and tested this exact commit on every platform, and that succeeded. */
export function prereleasePassed(runs, sha) {
  return Array.isArray(runs) && runs.some((r) => r?.headSha === sha && r?.conclusion === 'success');
}

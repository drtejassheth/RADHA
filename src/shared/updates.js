// Pure helpers for the updater (kept free of Electron so they can be unit-tested).

/** -1, 0 or 1, comparing "0.2.10" with "0.2.9" numerically. */
export function compareVersions(a, b) {
  const pa = String(a).replace(/^v/, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b).replace(/^v/, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1;
  }
  return 0;
}

/** The release file for this computer, or null. */
export function pickAsset(assets, platform = process.platform, arch = process.arch) {
  const re = platform === 'darwin' ? (arch === 'arm64' ? /-arm64\.dmg$/ : /-x64\.dmg$/) : platform === 'win32' ? /Setup-.*-x64\.exe$/ : null;
  return re ? assets.find((a) => re.test(a.name)) || null : null;
}

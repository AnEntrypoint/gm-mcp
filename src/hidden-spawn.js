// The option set for a detached child that must not open a console window.
// Every detached spawn in gm-mcp takes its options from here, so the set cannot drift between sites.
export function hiddenDetachedOptions(overrides = {}) {
    return { detached: true, stdio: 'ignore', windowsHide: true, ...overrides }
}

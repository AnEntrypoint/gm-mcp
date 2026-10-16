export function hiddenDetachedOptions(overrides = {}) {
    return { detached: true, stdio: 'ignore', windowsHide: true, ...overrides }
}

import { AsyncLocalStorage } from 'node:async_hooks'
import path from 'node:path'

export const CLIENT_CWD_HEADER = 'x-gm-client-cwd'

export const clientCwdContext = new AsyncLocalStorage()

export function clientCwdFromHeaders(headers) {
    const value = headers[CLIENT_CWD_HEADER]
    return typeof value === 'string' && path.isAbsolute(value) ? value : null
}

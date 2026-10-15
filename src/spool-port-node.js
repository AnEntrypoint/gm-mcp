// The node implementation of the spool port (see spool-port.js).
import fs from 'node:fs'
import { spawn } from 'node:child_process'

export const nodeSpoolPort = { fs, spawn }

#!/usr/bin/env node
import { main } from '../src/index.js'

main().catch((e) => {
    console.error(e)
    process.exit(1)
})

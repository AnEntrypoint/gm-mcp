import { main } from './index.js'

main().catch((e) => {
    console.error(e)
    process.exit(1)
})

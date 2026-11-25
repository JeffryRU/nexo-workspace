// Host de prueba que se cae justo después de anunciarse (bucle de caídas).
process.send({ t: 'ready' })
setTimeout(() => process.exit(1), 5)

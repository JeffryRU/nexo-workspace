// Host de prueba hostil: responde a spawn con basura mezclada con mensajes válidos.
process.send({ t: 'ready' })
process.on('message', (msg) => {
  if (msg.t !== 'spawn') return
  process.send({ t: 'spawned', id: msg.id, pid: 4242 })
  process.send('no soy un objeto')
  process.send(null)
  process.send({ t: 'data', id: msg.id, data: 'x'.repeat(2 * 1024 * 1024) })
  process.send({ t: 'data', id: -5, data: 'hola' })
  process.send({ t: 'data', id: msg.id, data: 42 })
  process.send({ t: 'exit', id: msg.id, exitCode: 'cero', signal: null })
  process.send({ t: 'data', id: 999999, data: 'de otra terminal' })
  process.send({ t: 'desconocido' })
  process.send({ t: 'data', id: msg.id, data: 'valido' })
  process.send({ t: 'exit', id: msg.id, exitCode: 0, signal: null })
})
